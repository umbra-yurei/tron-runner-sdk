use crate::{protocol_version::RUNNER_CHANNEL_ADDRESS, Error};
use url::Url;

/// Where a runner connects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    websocket_url: Url,
}

impl Endpoint {
    /// Connects to the runner channel of the Tron at `base_url` (`https://tron.example.com`); the channel's
    /// path is the one the published protocol document names. `http`/`https` become `ws`/`wss`.
    pub fn from_base_url(base_url: &str) -> Result<Self, Error> {
        let mut url = parse(base_url)?;
        let scheme = match url.scheme() {
            "http" | "ws" => "ws",
            "https" | "wss" => "wss",
            other => return Err(Error::Configuration(format!("unsupported URL scheme `{other}`"))),
        };
        url.set_scheme(scheme)
            .map_err(|()| Error::Configuration(format!("cannot use {base_url} as a WebSocket URL")))?;
        url.set_path(RUNNER_CHANNEL_ADDRESS);
        url.set_query(None);
        Ok(Self { websocket_url: url })
    }

    /// Connects to this exact `ws://` or `wss://` URL, for a Tron behind a proxy that mounts the runner channel elsewhere.
    pub fn from_websocket_url(websocket_url: &str) -> Result<Self, Error> {
        let url = parse(websocket_url)?;
        match url.scheme() {
            "ws" | "wss" => Ok(Self { websocket_url: url }),
            other => Err(Error::Configuration(format!("a WebSocket URL must be ws or wss, not `{other}`"))),
        }
    }

    /// The WebSocket URL the runner connects to.
    pub fn websocket_url(&self) -> &str {
        self.websocket_url.as_str()
    }
}

fn parse(text: &str) -> Result<Url, Error> {
    Url::parse(text).map_err(|error| Error::Configuration(format!("invalid URL {text:?}: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_gets_the_channel_path_and_a_websocket_scheme() {
        let endpoint = Endpoint::from_base_url("https://tron.example.com/").unwrap();
        assert_eq!(endpoint.websocket_url(), format!("wss://tron.example.com{RUNNER_CHANNEL_ADDRESS}"));
        let local = Endpoint::from_base_url("http://127.0.0.1:8090").unwrap();
        assert_eq!(local.websocket_url(), format!("ws://127.0.0.1:8090{RUNNER_CHANNEL_ADDRESS}"));
    }

    #[test]
    fn websocket_url_is_used_as_given() {
        let endpoint = Endpoint::from_websocket_url("ws://127.0.0.1:1/").unwrap();
        assert_eq!(endpoint.websocket_url(), "ws://127.0.0.1:1/");
        assert!(Endpoint::from_websocket_url("http://x").is_err());
        assert!(Endpoint::from_base_url("ftp://x").is_err());
    }
}
