use async_trait::async_trait;
use std::{
    io,
    path::{Path, PathBuf},
};

/// A failure of a [`SecretStore`] implementation.
#[derive(Debug, thiserror::Error)]
#[error(transparent)]
pub struct SecretStoreError(Box<dyn std::error::Error + Send + Sync>);

impl SecretStoreError {
    /// Wraps any error an implementation of [`SecretStore`] produces.
    pub fn new(source: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> Self {
        Self(source.into())
    }
}

impl From<io::Error> for SecretStoreError {
    fn from(source: io::Error) -> Self {
        Self::new(source)
    }
}

/// Durable storage for the one-time secret Tron returns when a delivery is accepted.
///
/// The secret is the only way to report the delivery's result, and Tron never shows it again, so it is
/// saved before the handler runs and removed once Tron has recorded the report. It is the only state
/// that must survive a restart: a restarted process finds its accepted-but-unreported deliveries with
/// [`SecretStore::pending`] and reports them with [`Runner::report`](crate::Runner::report).
///
/// Implement this over a database or a secret manager; [`FileSecretStore`] is the default.
#[async_trait]
pub trait SecretStore: Send + Sync + 'static {
    /// Durably stores the secret of an accepted delivery.
    async fn save(&self, delivery_id: &str, secret: &str) -> Result<(), SecretStoreError>;
    /// Returns the stored secret, or `None` when the delivery has none.
    async fn load(&self, delivery_id: &str) -> Result<Option<String>, SecretStoreError>;
    /// Forgets the secret of a delivery whose report Tron has recorded. Removing an absent secret succeeds.
    async fn remove(&self, delivery_id: &str) -> Result<(), SecretStoreError>;
    /// The deliveries that were accepted and not yet reported.
    async fn pending(&self) -> Result<Vec<String>, SecretStoreError>;
}

const FILE_EXTENSION: &str = "secret";

/// The default [`SecretStore`]: one file per delivery in a directory, readable only by its owner on Unix.
#[derive(Debug, Clone)]
pub struct FileSecretStore {
    directory: PathBuf,
}

impl FileSecretStore {
    /// Stores secrets in `directory`, which is created when it does not exist.
    pub fn new(directory: impl Into<PathBuf>) -> Result<Self, SecretStoreError> {
        let directory = directory.into();
        std::fs::create_dir_all(&directory)?;
        Ok(Self { directory })
    }

    /// The directory the secrets live in.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn path(&self, delivery_id: &str) -> Result<PathBuf, SecretStoreError> {
        let plain = !delivery_id.is_empty() && delivery_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !plain {
            return Err(SecretStoreError::new(format!(
                "delivery id {delivery_id:?} is not a plain identifier"
            )));
        }
        Ok(self.directory.join(format!("{delivery_id}.{FILE_EXTENSION}")))
    }
}

fn write_private(path: &Path, secret: &str) -> io::Result<()> {
    use std::io::Write;
    let temporary = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&temporary)?;
    file.write_all(secret.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temporary, path)?;
    if let Some(parent) = path.parent() {
        // Directory fsync is how the rename itself becomes durable; not every platform allows opening a directory.
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

#[async_trait]
impl SecretStore for FileSecretStore {
    async fn save(&self, delivery_id: &str, secret: &str) -> Result<(), SecretStoreError> {
        let path = self.path(delivery_id)?;
        let secret = secret.to_owned();
        tokio::task::spawn_blocking(move || write_private(&path, &secret))
            .await
            .map_err(SecretStoreError::new)??;
        Ok(())
    }

    async fn load(&self, delivery_id: &str) -> Result<Option<String>, SecretStoreError> {
        match tokio::fs::read_to_string(self.path(delivery_id)?).await {
            Ok(secret) => Ok(Some(secret)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    async fn remove(&self, delivery_id: &str) -> Result<(), SecretStoreError> {
        match tokio::fs::remove_file(self.path(delivery_id)?).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    async fn pending(&self) -> Result<Vec<String>, SecretStoreError> {
        let mut entries = tokio::fs::read_dir(&self.directory).await?;
        let mut pending = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) == Some(FILE_EXTENSION) {
                if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                    pending.push(stem.to_owned());
                }
            }
        }
        pending.sort();
        Ok(pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn saves_loads_lists_and_removes() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(directory.path().join("nested")).unwrap();
        assert_eq!(store.load("a").await.unwrap(), None);
        store.save("a", "one").await.unwrap();
        store.save("b", "two").await.unwrap();
        store.save("a", "uno").await.unwrap();
        assert_eq!(store.load("a").await.unwrap().as_deref(), Some("uno"));
        assert_eq!(store.pending().await.unwrap(), ["a", "b"]);
        store.remove("a").await.unwrap();
        store.remove("a").await.unwrap();
        assert_eq!(store.pending().await.unwrap(), ["b"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn secret_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(directory.path()).unwrap();
        store.save("a", "one").await.unwrap();
        let mode = std::fs::metadata(directory.path().join("a.secret")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[tokio::test]
    async fn refuses_delivery_ids_that_are_not_plain_identifiers() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(directory.path()).unwrap();
        assert!(store.save("../escape", "x").await.is_err());
        assert!(store.load("").await.is_err());
    }
}
