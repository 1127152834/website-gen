<?php
/**
 * Plugin Name:       Site Companion
 * Description:       Lets the website-gen desktop app manage this store over the REST API.
 * Version:           0.2.0
 * Requires at least: 6.8
 * Requires PHP:      8.1
 * License:           GPLv2 or later
 * Text Domain:       site-companion
 */

defined( 'ABSPATH' ) || exit;

const SITE_COMPANION_USER           = 'site-agent';
const SITE_COMPANION_APP_PASSWORD    = 'website-gen';
const SITE_COMPANION_ENROLLED_GEN    = 'site_companion_enrolled_generation';

/**
 * Per-site enrollment config written by the desktop app at deploy time:
 * [ 'token_hash' => sha256 hex of the one-time token, 'expires' => unix time, 'generation' => int ].
 * Each deploy carries a higher generation, so the app can re-enroll (e.g. after losing the credentials),
 * while a used token can never be replayed. The template in resources/ has no enroll.php.
 */
function site_companion_enroll_config(): ?array {
	$file = __DIR__ . '/enroll.php';
	if ( ! is_readable( $file ) ) {
		return null;
	}
	$cfg = require $file;
	return is_array( $cfg ) && isset( $cfg['token_hash'], $cfg['expires'], $cfg['generation'] ) ? $cfg : null;
}

// Activation only creates the service user. Application passwords need HTTPS, and activation
// may run from WP-CLI, so the password is created later by the enroll request itself.
register_activation_hook( __FILE__, 'site_companion_activate' );
function site_companion_activate(): void {
	$user = get_user_by( 'login', SITE_COMPANION_USER );
	if ( ! $user ) {
		$host = wp_parse_url( home_url(), PHP_URL_HOST );
		$id   = wp_insert_user(
			array(
				'user_login'   => SITE_COMPANION_USER,
				'user_pass'    => wp_generate_password( 40, true, true ),
				'user_email'   => SITE_COMPANION_USER . '@' . $host,
				'display_name' => 'Site Agent',
				'role'         => get_role( 'shop_manager' ) ? 'shop_manager' : 'editor',
			)
		);
		if ( is_wp_error( $id ) ) {
			return;
		}
		$user = get_user_by( 'id', $id );
	}
	$user->add_cap( 'edit_theme_options' ); // global styles
}

add_action( 'rest_api_init', 'site_companion_routes' );
function site_companion_routes(): void {
	register_rest_route(
		'site-agent/v1',
		'/enroll',
		array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true', // checked against the one-time token below
			'callback'            => 'site_companion_enroll',
		)
	);
	register_rest_route(
		'site-agent/v1',
		'/health',
		array(
			'methods'             => 'GET',
			'permission_callback' => fn() => current_user_can( 'manage_woocommerce' ) || current_user_can( 'edit_pages' ),
			'callback'            => 'site_companion_health',
		)
	);
}

function site_companion_enroll( WP_REST_Request $request ) {
	$cfg   = site_companion_enroll_config();
	$token = (string) $request->get_header( 'x-site-agent-enroll' );
	$valid = $cfg
		&& (int) $cfg['generation'] > (int) get_option( SITE_COMPANION_ENROLLED_GEN, 0 )
		&& $cfg['expires'] >= time()
		&& '' !== $token
		&& hash_equals( (string) $cfg['token_hash'], hash( 'sha256', $token ) );
	if ( ! $valid ) {
		return new WP_Error( 'site_companion_forbidden', 'Enrollment is not available.', array( 'status' => 403 ) );
	}

	$user = get_user_by( 'login', SITE_COMPANION_USER );
	if ( ! $user ) {
		return new WP_Error( 'site_companion_no_user', 'Plugin has not been activated.', array( 'status' => 409 ) );
	}
	if ( ! wp_is_application_passwords_available_for_user( $user ) ) {
		return new WP_Error( 'site_companion_no_app_passwords', 'Application passwords are unavailable (HTTPS required).', array( 'status' => 409 ) );
	}

	// Re-enrolling rotates the credential: earlier passwords issued to the app stop working.
	foreach ( WP_Application_Passwords::get_user_application_passwords( $user->ID ) as $item ) {
		if ( SITE_COMPANION_APP_PASSWORD === $item['name'] ) {
			WP_Application_Passwords::delete_application_password( $user->ID, $item['uuid'] );
		}
	}
	$created = WP_Application_Passwords::create_new_application_password( $user->ID, array( 'name' => SITE_COMPANION_APP_PASSWORD ) );
	if ( is_wp_error( $created ) ) {
		return $created;
	}
	update_option( SITE_COMPANION_ENROLLED_GEN, (int) $cfg['generation'], false ); // this token (and older ones) can never be used again

	return array(
		'username' => SITE_COMPANION_USER,
		'password' => $created[0],
		'site'     => home_url(),
	);
}

function site_companion_health(): array {
	$theme = wp_get_theme();
	return array(
		'wp'          => get_bloginfo( 'version' ),
		'php'         => PHP_VERSION,
		'woocommerce' => defined( 'WC_VERSION' ) ? WC_VERSION : null,
		'theme'       => $theme->get_stylesheet() . ' ' . $theme->get( 'Version' ),
		'user'        => wp_get_current_user()->user_login,
	);
}
