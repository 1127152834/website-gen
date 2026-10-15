<?php
/**
 * Plugin Name:       Site Companion
 * Description:       Lets the website-gen desktop app manage this store over the REST API.
 * Version:           0.4.0
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
const SITE_COMPANION_OPTIONS         = array( 'blogname', 'blogdescription', 'blog_public', 'show_on_front', 'page_on_front', 'wp_page_for_privacy_policy', 'woocommerce_coming_soon' );
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
				array(
					'methods'             => 'GET',
					'permission_callback' => fn() => current_user_can( 'manage_woocommerce' ),
					'callback'            => 'site_companion_get_privacy_page',
				),
				array(
					'methods'             => 'POST',
					'permission_callback' => fn() => current_user_can( 'manage_woocommerce' ),
					'callback'            => 'site_companion_privacy_page',
				),
			)
		);
	}
);
// Raw title and content of the privacy policy page, so the app can snapshot it before an edit.
function site_companion_get_privacy_page() {
	$page = get_post( (int) get_option( 'wp_page_for_privacy_policy' ) );
	if ( ! $page || 'page' !== $page->post_type ) {
		return new WP_Error( 'site_companion_no_privacy_page', 'No privacy policy page is set.', array( 'status' => 404 ) );
	}
	return array(
		'id'      => $page->ID,
		'title'   => $page->post_title,
		'content' => $page->post_content,
	);
}
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
		} elseif ( 'woocommerce_coming_soon' === $name ) {
			$value = 'yes' === $value ? 'yes' : 'no';
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

// ---- Transactional mail over SMTP --------------------------------------------------------------
// WooCommerce and WordPress mail goes out through the store's own mailbox (e.g. support@ on Hostinger Email)
// instead of the web server's sendmail, which mailbox providers often junk. The SMTP password is stored
// encrypted with a key derived from this site's auth salt, so a database dump alone does not reveal it.
const SITE_COMPANION_SMTP = 'site_companion_smtp';

function site_companion_smtp_key(): string {
	return hash( 'sha256', wp_salt( 'auth' ) . '|site-companion-smtp', true );
}
function site_companion_seal( string $plain ): string {
	$nonce = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
	return base64_encode( $nonce . sodium_crypto_secretbox( $plain, $nonce, site_companion_smtp_key() ) );
}
function site_companion_unseal( string $sealed ): ?string {
	$raw = base64_decode( $sealed, true );
	if ( false === $raw || strlen( $raw ) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ) {
		return null;
	}
	$plain = sodium_crypto_secretbox_open( substr( $raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ), substr( $raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ), site_companion_smtp_key() );
	return false === $plain ? null : $plain;
}

/** Stored SMTP settings with the password decrypted, or null when SMTP is off. */
function site_companion_smtp_config(): ?array {
	$cfg = get_option( SITE_COMPANION_SMTP );
	if ( ! is_array( $cfg ) || empty( $cfg['host'] ) || empty( $cfg['password'] ) ) {
		return null;
	}
	$password = site_companion_unseal( (string) $cfg['password'] );
	return null === $password ? null : array( 'password' => $password ) + $cfg;
}

add_action( 'phpmailer_init', 'site_companion_phpmailer' );
function site_companion_phpmailer( $phpmailer ): void {
	$cfg = site_companion_smtp_config();
	if ( ! $cfg ) {
		return;
	}
	$phpmailer->isSMTP();
	$phpmailer->Host       = $cfg['host'];
	$phpmailer->Port       = (int) $cfg['port'];
	$phpmailer->SMTPSecure = $cfg['secure'];
	$phpmailer->SMTPAuth   = true;
	$phpmailer->Username   = $cfg['username'];
	$phpmailer->Password   = $cfg['password'];
	$phpmailer->Timeout    = 20;
	// The SMTP server only accepts mail sent as the mailbox it authenticated.
	$phpmailer->setFrom( $cfg['from_email'], $cfg['from_name'] ? $cfg['from_name'] : $phpmailer->FromName, false );
	$phpmailer->Sender = $cfg['from_email'];
}

add_action(
	'rest_api_init',
	static function (): void {
		$can = fn() => current_user_can( 'manage_woocommerce' );
		register_rest_route(
			'site-agent/v1',
			'/smtp',
			array(
				array( 'methods' => 'GET', 'permission_callback' => $can, 'callback' => 'site_companion_get_smtp' ),
				array( 'methods' => 'POST', 'permission_callback' => $can, 'callback' => 'site_companion_set_smtp' ),
			)
		);
		register_rest_route( 'site-agent/v1', '/smtp/test', array( 'methods' => 'POST', 'permission_callback' => $can, 'callback' => 'site_companion_test_smtp' ) );
	}
);

function site_companion_get_smtp(): array {
	$cfg = get_option( SITE_COMPANION_SMTP );
	$on  = null !== site_companion_smtp_config();
	return array(
		'enabled'    => $on,
		'host'       => $on ? $cfg['host'] : null,
		'port'       => $on ? (int) $cfg['port'] : null,
		'secure'     => $on ? $cfg['secure'] : null,
		'username'   => $on ? $cfg['username'] : null,
		'from_email' => $on ? $cfg['from_email'] : null,
		'from_name'  => $on ? $cfg['from_name'] : null,
	);
}

function site_companion_set_smtp( WP_REST_Request $request ) {
	if ( false === $request->get_param( 'enabled' ) ) {
		delete_option( SITE_COMPANION_SMTP );
		return site_companion_get_smtp();
	}
	$host     = sanitize_text_field( (string) $request->get_param( 'host' ) );
	$port     = (int) $request->get_param( 'port' );
	$secure   = (string) $request->get_param( 'secure' );
	$username = sanitize_email( (string) $request->get_param( 'username' ) );
	$from     = sanitize_email( (string) $request->get_param( 'from_email' ) );
	$password = (string) $request->get_param( 'password' );
	if ( '' === $host || ! in_array( $port, array( 25, 465, 587, 2525 ), true ) || ! in_array( $secure, array( 'ssl', 'tls', '' ), true ) || ! is_email( $username ) || ! is_email( $from ) || '' === $password ) {
		return new WP_Error( 'site_companion_smtp', 'host, port (25/465/587/2525), secure (ssl/tls), username, from_email and password are required.', array( 'status' => 400 ) );
	}
	update_option(
		SITE_COMPANION_SMTP,
		array(
			'host'       => $host,
			'port'       => $port,
			'secure'     => $secure,
			'username'   => $username,
			'password'   => site_companion_seal( $password ),
			'from_email' => $from,
			'from_name'  => sanitize_text_field( (string) $request->get_param( 'from_name' ) ),
		),
		false
	);
	return site_companion_get_smtp();
}

// Sends one plain-text email through wp_mail (the same path WooCommerce uses) and reports the SMTP error if any.
function site_companion_test_smtp( WP_REST_Request $request ) {
	$to = sanitize_email( (string) $request->get_param( 'to' ) );
	if ( ! is_email( $to ) ) {
		return new WP_Error( 'site_companion_smtp_test', 'A valid "to" address is required.', array( 'status' => 400 ) );
	}
	$error  = null;
	$listen = function ( WP_Error $e ) use ( &$error ) {
		$error = $e->get_error_message();
	};
	add_action( 'wp_mail_failed', $listen );
	$subject = sanitize_text_field( (string) $request->get_param( 'subject' ) );
	$sent    = wp_mail( $to, '' !== $subject ? $subject : 'Test email from ' . get_bloginfo( 'name' ), "This is a test email from your store's mail settings.\n\nIf you received it, order emails will be delivered the same way.\n" );
	remove_action( 'wp_mail_failed', $listen );
	return array(
		'ok'    => (bool) $sent && null === $error,
		'smtp'  => null !== site_companion_smtp_config(),
		'error' => $error,
	);
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
