//! Maps to: CC `components/memory/**`.

pub mod memory_file_selector;
pub mod memory_update_notification;

pub use memory_file_selector::{
    ADD_CANDIDATE_PREFIX, CONSOLIDATE_MEMORY_VALUE, DELETE_CANDIDATE_PREFIX, MemoryFileSelector,
};
pub use memory_update_notification::{MemoryUpdateNotification, get_relative_memory_path};
