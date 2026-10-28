//! Consolidation lock for auto-dream.
//!
//! @nyan: `.consolidate-lock` is both the last-start marker used by `/memory`
//! and a crash-recoverable pid lease. A failed or killed lease restores the
//! prior mtime so the next idle trigger can retry immediately.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const LOCK_FILE_NAME: &str = ".consolidate-lock";
const STALE_AFTER: Duration = Duration::from_secs(60 * 60);

#[derive(Debug)]
pub enum LockAcquireError {
    Busy { pid: u32, started_at_ms: u64 },
    Io(io::Error),
}

impl fmt::Display for LockAcquireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Busy { pid, started_at_ms } => write!(
                formatter,
                "memory consolidation is already running (pid {pid}, started at {started_at_ms})"
            ),
            Self::Io(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for LockAcquireError {}

impl From<io::Error> for LockAcquireError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug)]
pub struct ConsolidationLock {
    path: PathBuf,
    prior_mtime_ms: Option<u64>,
    start_mtime_ms: u64,
    settled: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn mtime_ms(path: &Path) -> io::Result<Option<u64>> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn set_mtime_ms(path: &Path, milliseconds: u64) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "lock path contains NUL"))?;
    let seconds = (milliseconds / 1_000) as libc::time_t;
    let nanos = ((milliseconds % 1_000) * 1_000_000) as libc::c_long;
    let times = [
        libc::timespec {
            tv_sec: seconds,
            tv_nsec: nanos,
        },
        libc::timespec {
            tv_sec: seconds,
            tv_nsec: nanos,
        },
    ];
    let result = unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
fn set_mtime_ms(_path: &Path, _milliseconds: u64) -> io::Result<()> {
    // Windows support can use the standard file-time API when this target is
    // enabled; the lock content remains useful even when mtime cannot be set.
    Ok(())
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn process_is_alive(pid: u32) -> bool {
    pid == std::process::id()
}

fn existing_lease(path: &Path) -> io::Result<Option<(u32, u64)>> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut fields = content.split_whitespace();
    let Some(pid) = fields.next().and_then(|value| value.parse().ok()) else {
        return Ok(None);
    };
    let Some(started_at_ms) = fields.next().and_then(|value| value.parse().ok()) else {
        return Ok(None);
    };
    Ok(Some((pid, started_at_ms)))
}

impl ConsolidationLock {
    pub fn path(memory_dir: &Path) -> PathBuf {
        memory_dir.join(LOCK_FILE_NAME)
    }

    pub fn acquire(memory_dir: &Path) -> Result<Self, LockAcquireError> {
        fs::create_dir_all(memory_dir)?;
        let path = Self::path(memory_dir);
        let prior_mtime_ms = mtime_ms(&path)?;
        if let Some((pid, started_at_ms)) = existing_lease(&path)? {
            let age_ms = now_ms().saturating_sub(started_at_ms);
            if process_is_alive(pid) && age_ms <= STALE_AFTER.as_millis() as u64 {
                return Err(LockAcquireError::Busy { pid, started_at_ms });
            }
        }

        let start_mtime_ms = now_ms();
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&path)?;
        writeln!(file, "{} {start_mtime_ms}", std::process::id())?;
        file.sync_all()?;
        set_mtime_ms(&path, start_mtime_ms)?;
        Ok(Self {
            path,
            prior_mtime_ms,
            start_mtime_ms,
            settled: false,
        })
    }

    pub fn prior_mtime_ms(&self) -> Option<u64> {
        self.prior_mtime_ms
    }

    pub fn start_mtime_ms(&self) -> u64 {
        self.start_mtime_ms
    }

    /// Mark a successful consolidation. The pid is cleared, while the start
    /// mtime remains the last-run marker.
    pub fn complete(&mut self) -> io::Result<()> {
        fs::write(&self.path, "")?;
        set_mtime_ms(&self.path, self.start_mtime_ms)?;
        self.settled = true;
        Ok(())
    }

    /// Restore the pre-run mtime and clear/remove the lease for retry.
    pub fn rollback(&mut self) -> io::Result<()> {
        if let Some(prior_mtime_ms) = self.prior_mtime_ms {
            fs::write(&self.path, "")?;
            set_mtime_ms(&self.path, prior_mtime_ms)?;
        } else {
            match fs::remove_file(&self.path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        self.settled = true;
        Ok(())
    }
}

impl Drop for ConsolidationLock {
    fn drop(&mut self) {
        if !self.settled {
            let _ = self.rollback();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("nyan-dream-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn successful_lock_clears_pid_and_keeps_start_mtime() {
        let dir = temp_dir();
        let mut lock = ConsolidationLock::acquire(&dir).unwrap();
        let start = lock.start_mtime_ms();
        assert!(matches!(
            ConsolidationLock::acquire(&dir),
            Err(LockAcquireError::Busy { .. })
        ));
        lock.complete().unwrap();
        assert_eq!(
            fs::read_to_string(ConsolidationLock::path(&dir)).unwrap(),
            ""
        );
        assert_eq!(
            mtime_ms(&ConsolidationLock::path(&dir)).unwrap(),
            Some(start)
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rollback_removes_new_lock_and_allows_retry() {
        let dir = temp_dir();
        let mut lock = ConsolidationLock::acquire(&dir).unwrap();
        lock.rollback().unwrap();
        assert!(!ConsolidationLock::path(&dir).exists());
        assert!(ConsolidationLock::acquire(&dir).is_ok());
        let _ = fs::remove_dir_all(dir);
    }
}
