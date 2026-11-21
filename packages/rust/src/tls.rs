//! The TLS settings for `wss://` connections.
//!
//! The SDK picks the crypto provider itself (`ring`) and hands the connection an explicit rustls config, so it never
//! depends on a process-wide default provider and never installs one: an application that installed its own
//! (or enables `aws-lc-rs` elsewhere in its tree) is not affected.

use rustls::{pki_types::CertificateDer, ClientConfig, RootCertStore};
use std::sync::Arc;

pub(crate) fn client_config(extra_roots: &[CertificateDer<'static>]) -> Result<Arc<ClientConfig>, rustls::Error> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for root in extra_roots {
        roots.add(root.clone())?;
    }
    let config = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

#[cfg(test)]
mod tests {
    use crate::{
        protocol::{AuthenticationFailedFrame, AuthenticationFailedFrameType},
        Endpoint, Error, Runner,
    };
    use futures_util::{SinkExt, StreamExt};
    use rustls::{pki_types::PrivateKeyDer, ServerConfig};
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio_rustls::TlsAcceptor;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    /// A real TLS handshake against a local `wss://` server whose certificate is trusted through a test-only root.
    /// Without an explicit provider rustls panics on the first handshake, which is what 0.1.0 did against Tron.
    #[tokio::test]
    async fn connects_over_wss_without_any_provider_set_up_by_the_application() {
        let certified = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
        let root = certified.cert.der().clone();
        let key = PrivateKeyDer::try_from(certified.key_pair.serialize_der()).unwrap();
        let server_config = ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![root.clone()], key)
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(server_config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Endpoint::from_websocket_url(&format!("wss://localhost:{}/", listener.local_addr().unwrap().port())).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(acceptor.accept(stream).await.unwrap()).await.unwrap();
            socket.next().await.expect("the runner sent no authenticate frame").unwrap();
            let failed = AuthenticationFailedFrame {
                authentication_failed_frame_type: AuthenticationFailedFrameType::AuthenticationFailed,
            };
            socket.send(Message::text(serde_json::to_string(&failed).unwrap())).await.unwrap();
        });
        let result = Runner::builder(endpoint, "bad-key")
            .trust_root(root)
            .on("h", |_| async { Ok(String::new()) })
            .connect()
            .await;
        assert!(
            matches!(result, Err(Error::AuthenticationFailed)),
            "expected the TLS handshake and the frames to reach authentication"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn refuses_a_certificate_the_webpki_roots_do_not_vouch_for() {
        let certified = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
        let key = PrivateKeyDer::try_from(certified.key_pair.serialize_der()).unwrap();
        let server_config = ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![certified.cert.der().clone()], key)
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(server_config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Endpoint::from_websocket_url(&format!("wss://localhost:{}/", listener.local_addr().unwrap().port())).unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let _ = acceptor.accept(stream).await;
        });
        let result = Runner::builder(endpoint, "k")
            .on("h", |_| async { Ok(String::new()) })
            .connect()
            .await;
        assert!(
            matches!(result, Err(Error::Unreachable(_))),
            "an untrusted certificate must be refused"
        );
    }
}
