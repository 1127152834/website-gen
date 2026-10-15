<?php
/**
 * Plugin Name:       Site Companion
 * Description:       Lets the website-gen desktop app manage this store over the REST API.
 * Version:           0.3.1
 * Requires at least: 6.8
 * Requires PHP:      8.1
 * License:           GPLv2 or later
 * Text Domain:       site-companion
 */

defined( 'ABSPATH' ) || exit;

const SITE_COMPANION_USER           = 'site-agent';
const SITE_COMPANION_APP_PASSWORD    = 'website-gen';
const SITE_COMPANION_ENROLLED_GEN    = 'site_companion_enrolled_generation';
const SITE_COMPANION_INFO            = 'site_companion_info';
// Site options the app may set through /site. The service user is a shop manager without manage_options,
// so this short allow-list is the only way it can change them.
const SITE_COMPANION_OPTIONS         = array( 'blogname', 'blogdescription', 'blog_public', 'show_on_front', 'page_on_front', 'wp_page_for_privacy_policy' );
const SITE_COMPANION_INFO_KEYS       = array( 'entity', 'email', 'phone', 'address', 'announcement' );

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
	register_rest_route(
		'site-agent/v1',
		'/site',
		array(
			array(
				'methods'             => 'GET',
				'permission_callback' => fn() => current_user_can( 'manage_woocommerce' ),
				'callback'            => 'site_companion_get_site',
			),
			array(
				'methods'             => 'POST',
				'permission_callback' => fn() => current_user_can( 'manage_woocommerce' ),
				'callback'            => 'site_companion_set_site',
			),
		)
	);
}

// The page set as the privacy policy page needs manage_privacy_options (an admin capability) to edit,
// so the shop manager cannot even see it in REST edit lists. This endpoint publishes it at /privacy-policy/
// (reusing the draft WordPress created at install) and points the privacy policy setting at it.
add_action(
	'rest_api_init',
	static function (): void {
		register_rest_route(
			'site-agent/v1',
			'/privacy-page',
			array(
				'methods'             => 'POST',
				'permission_callback' => fn() => current_user_can( 'manage_woocommerce' ),
				'callback'            => 'site_companion_privacy_page',
			)
		);
	}
);
function site_companion_privacy_page( WP_REST_Request $request ) {
	$existing = get_page_by_path( 'privacy-policy', OBJECT, 'page' );
	$page     = array(
		'post_type'    => 'page',
		'post_status'  => 'publish',
		'post_name'    => 'privacy-policy',
		'post_title'   => sanitize_text_field( (string) $request->get_param( 'title' ) ),
		'post_content' => wp_kses_post( (string) $request->get_param( 'content' ) ),
	);
	$id = $existing ? wp_update_post( array( 'ID' => $existing->ID ) + $page, true ) : wp_insert_post( $page, true );
	if ( is_wp_error( $id ) ) {
		return $id;
	}
	update_option( 'wp_page_for_privacy_policy', (int) $id );
	return array( 'id' => (int) $id );
}

function site_companion_get_site(): array {
	$options = array();
	foreach ( SITE_COMPANION_OPTIONS as $name ) {
		$options[ $name ] = get_option( $name );
	}
	return array(
		'options' => $options,
		'info'    => (array) get_option( SITE_COMPANION_INFO, array() ),
	);
}

function site_companion_set_site( WP_REST_Request $request ) {
	$options = (array) $request->get_param( 'options' );
	foreach ( array_keys( $options ) as $name ) {
		if ( ! in_array( $name, SITE_COMPANION_OPTIONS, true ) ) {
			return new WP_Error( 'site_companion_option', "Option {$name} cannot be changed here.", array( 'status' => 400 ) );
		}
	}
	foreach ( $options as $name => $value ) {
		if ( in_array( $name, array( 'blog_public', 'page_on_front', 'wp_page_for_privacy_policy' ), true ) ) {
			$value = absint( $value );
		} elseif ( 'show_on_front' === $name ) {
			$value = 'page' === $value ? 'page' : 'posts';
		} else {
			$value = sanitize_text_field( (string) $value );
		}
		update_option( $name, $value );
	}
	$info = $request->get_param( 'info' );
	if ( is_array( $info ) ) {
		$info = array_intersect_key( $info, array_flip( SITE_COMPANION_INFO_KEYS ) );
		update_option( SITE_COMPANION_INFO, array_map( fn( $v ) => sanitize_text_field( (string) $v ), $info ), false );
	}
	return site_companion_get_site();
}

// [site_info key="email|phone|address|entity|announcement|copyright"]: per-site details used by the shared theme's header and footer.
add_shortcode( 'site_info', 'site_companion_info_shortcode' );
function site_companion_info_shortcode( $atts ): string {
	$key  = (string) shortcode_atts( array( 'key' => '' ), $atts )['key'];
	$info = (array) get_option( SITE_COMPANION_INFO, array() );
	$text = (string) ( $info[ $key ] ?? '' );
	switch ( $key ) {
		case 'copyright':
			return esc_html( '© ' . gmdate( 'Y' ) . ' ' . ( $info['entity'] ?? get_bloginfo( 'name' ) ) . '. All rights reserved.' );
		case 'email':
			return '' === $text ? '' : '<a href="mailto:' . esc_attr( $text ) . '">' . esc_html( $text ) . '</a>';
		case 'phone':
			return '' === $text ? '' : '<a href="tel:' . esc_attr( preg_replace( '/[^\d+]/', '', $text ) ) . '">' . esc_html( $text ) . '</a>';
		default:
			return esc_html( $text );
	}
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
