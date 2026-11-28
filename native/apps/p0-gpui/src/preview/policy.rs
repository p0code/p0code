//! What the Preview tab may load. Pure, so the rules are tested without a webview.
//!
//! Opening is gated: chat links and other untrusted text reach only loopback addresses or the
//! connected server's host (where its forwarded ports live); any other site needs an `https`
//! address the user typed. Navigations the page itself makes are limited to http(s) so a page
//! cannot reach `file:`, `javascript:` or app schemes.

use url::Url;

/// Who asked for the URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// Typed into the address bar.
    Typed,
    /// A link from chat, a tool result or another untrusted source.
    Link,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlError {
    Empty,
    Invalid,
    /// Not http or https.
    Scheme,
    /// Carries a user name or password.
    Credentials,
    /// Neither loopback, the server's host, nor a typed https address.
    Host,
}

impl UrlError {
    /// English copy, translated through the shared catalogs.
    pub fn message(self) -> &'static str {
        match self {
            Self::Empty | Self::Invalid => "Enter a localhost or https address.",
            Self::Scheme | Self::Credentials | Self::Host => {
                "Only localhost, this server, or https addresses can be previewed."
            }
        }
    }
}

/// Resolves address-bar or link text to a URL the preview may open. A bare `:3000` or `3000`
/// means that port on localhost; a missing scheme is `http` for loopback and `https` otherwise.
pub fn resolve(input: &str, server_base: &str, origin: Origin) -> Result<Url, UrlError> {
    let text = input.trim();
    if text.is_empty() {
        return Err(UrlError::Empty);
    }
    let port = text.strip_prefix(':').unwrap_or(text);
    let candidate = if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) {
        format!("http://localhost:{port}")
    } else if text.contains("://") || has_scheme(text) {
        text.to_owned()
    } else {
        let host = text.split(['/', '?', '#']).next().unwrap_or_default();
        let host = host.rsplit_once(':').map_or(host, |(h, p)| {
            if p.bytes().all(|b| b.is_ascii_digit()) {
                h
            } else {
                host
            }
        });
        if is_loopback_host(host.trim_start_matches('[').trim_end_matches(']')) {
            format!("http://{text}")
        } else {
            format!("https://{text}")
        }
    };
    let url = Url::parse(&candidate).map_err(|_| UrlError::Invalid)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(UrlError::Scheme);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(UrlError::Credentials);
    }
    if is_local(&url, server_base) || (origin == Origin::Typed && url.scheme() == "https") {
        Ok(url)
    } else {
        Err(UrlError::Host)
    }
}

/// Whether a chat link should open in the Preview tab instead of the system browser.
pub fn is_previewable_link(link: &str, server_base: &str) -> bool {
    resolve(link, server_base, Origin::Link).is_ok() && has_scheme(link.trim())
}

/// Whether the page may navigate (itself or a frame) to `url`.
pub fn page_may_navigate(url: &str) -> bool {
    url == "about:blank" || Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https"))
}

/// Loopback, or the same host as the connected server (its forwarded ports).
fn is_local(url: &Url, server_base: &str) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    is_loopback_host(host)
        || Url::parse(server_base)
            .ok()
            .and_then(|base| base.host_str().map(|h| h.eq_ignore_ascii_case(host)))
            .unwrap_or(false)
}

pub fn is_loopback_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

/// `scheme:` before any `/`, so `localhost:3000` is not mistaken for one.
fn has_scheme(text: &str) -> bool {
    let Some((scheme, rest)) = text.split_once(':') else {
        return false;
    };
    let alpha = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    alpha && !rest.starts_with(|c: char| c.is_ascii_digit())
}

pub fn is_pdf(name: &str, mime_type: &str) -> bool {
    mime_type.eq_ignore_ascii_case("application/pdf")
        || name
            .rsplit_once('.')
            .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("pdf"))
}

/// The page URL of a signed asset (`/api/assets/...`) on the server.
pub fn asset_url(server_base: &str, relative_url: &str) -> Option<Url> {
    if !relative_url.starts_with("/api/assets/") {
        return None;
    }
    Url::parse(server_base).ok()?.join(relative_url).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "http://127.0.0.1:3773";

    fn typed(s: &str) -> Result<String, UrlError> {
        resolve(s, BASE, Origin::Typed).map(String::from)
    }

    fn link(s: &str) -> Result<String, UrlError> {
        resolve(s, BASE, Origin::Link).map(String::from)
    }

    #[test]
    fn shorthand_becomes_localhost() {
        assert_eq!(typed("3000").unwrap(), "http://localhost:3000/");
        assert_eq!(typed(":5173").unwrap(), "http://localhost:5173/");
        assert_eq!(
            typed("localhost:3000/a?b").unwrap(),
            "http://localhost:3000/a?b"
        );
        assert_eq!(typed("127.0.0.1:8080").unwrap(), "http://127.0.0.1:8080/");
        assert_eq!(typed("[::1]:8080").unwrap(), "http://[::1]:8080/");
        assert_eq!(
            typed("app.localhost:3000").unwrap(),
            "http://app.localhost:3000/"
        );
        assert_eq!(typed("example.com").unwrap(), "https://example.com/");
        assert_eq!(typed("  "), Err(UrlError::Empty));
    }

    #[test]
    fn links_reach_only_loopback_and_the_server() {
        assert!(link("http://localhost:3000").is_ok());
        assert!(link("http://127.0.0.2:3000").is_ok());
        assert!(link("http://[::1]/").is_ok());
        assert!(link("http://127.0.0.1:41234/forwarded").is_ok());
        assert_eq!(link("https://example.com"), Err(UrlError::Host));
        assert_eq!(link("http://example.com"), Err(UrlError::Host));
        let lan = resolve("http://10.0.0.5:5173", "http://10.0.0.5:3773", Origin::Link);
        assert!(lan.is_ok(), "the server's own host is where its ports are");
    }

    #[test]
    fn typed_https_opens_anywhere_but_http_does_not() {
        assert!(typed("https://example.com/docs").is_ok());
        assert_eq!(typed("http://example.com"), Err(UrlError::Host));
    }

    #[test]
    fn other_schemes_and_credentials_are_refused() {
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "p0code://thread/1",
            "about:blank",
        ] {
            assert_eq!(typed(bad), Err(UrlError::Scheme), "{bad}");
            assert_eq!(link(bad), Err(UrlError::Scheme), "{bad}");
        }
        assert_eq!(
            typed("http://user:pw@localhost:3000"),
            Err(UrlError::Credentials)
        );
        assert_eq!(
            typed("https://token@example.com"),
            Err(UrlError::Credentials)
        );
        assert_eq!(typed("http://"), Err(UrlError::Invalid));
    }

    #[test]
    fn chat_links_open_in_preview_only_when_local_and_absolute() {
        assert!(is_previewable_link("http://localhost:5173/", BASE));
        assert!(!is_previewable_link("localhost:5173", BASE));
        assert!(!is_previewable_link("https://example.com", BASE));
        assert!(!is_previewable_link("file:///tmp/a.html", BASE));
    }

    #[test]
    fn page_navigation_stays_on_http() {
        assert!(page_may_navigate("https://example.com/"));
        assert!(page_may_navigate("http://localhost:3000/next"));
        assert!(page_may_navigate("about:blank"));
        assert!(!page_may_navigate("file:///etc/passwd"));
        assert!(!page_may_navigate("javascript:alert(1)"));
        assert!(!page_may_navigate("vscode://open"));
    }

    #[test]
    fn pdf_detection_and_asset_urls() {
        assert!(is_pdf("docs/Spec.PDF", ""));
        assert!(is_pdf("blob", "application/pdf"));
        assert!(!is_pdf("notes.md", "text/markdown"));
        assert_eq!(
            asset_url(BASE, "/api/assets/tok/spec.pdf")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:3773/api/assets/tok/spec.pdf"
        );
        assert!(asset_url(BASE, "https://elsewhere/x.pdf").is_none());
        assert!(asset_url(BASE, "//elsewhere/x.pdf").is_none());
    }
}
