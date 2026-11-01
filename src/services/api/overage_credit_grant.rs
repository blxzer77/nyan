//! Maps to: CC `services/api/overageCreditGrant.ts` cached grant helpers.
//!
//! Official code can fetch `/overage_credit_grant` and update
//! `GlobalConfig.overageCreditGrantCache`. Nyan keeps this slice read-only:
//! it only consumes existing cache entries and never performs OAuth/network
//! calls, invalidation writes, or analytics.

use crate::components::logo_v2::overage_credit_upsell::OverageCreditGrantInfo as UiGrantInfo;
use crate::utils::auth::is_anthropic_auth_enabled;
use crate::utils::config::GlobalConfig;
use serde::Deserialize;
use std::collections::HashMap;

pub const CACHE_TTL_MS: i64 = 60 * 60 * 1000;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct OverageCreditGrantInfo {
    pub available: bool,
    pub eligible: bool,
    pub granted: bool,
    pub amount_minor_units: Option<i64>,
    pub currency: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct OverageCreditGrantCacheEntry {
    pub info: OverageCreditGrantInfo,
    pub timestamp: i64,
}

/// Maps to: CC `services/api/overageCreditGrant.ts` `getCachedOverageCreditGrant`.
///
/// A `get_env` parameter was removed: the body never read it, and
/// `is_anthropic_auth_enabled` resolves from process state exactly as at the
/// source. It only served to make callers look like they could steer the gate.
pub fn get_cached_overage_credit_grant_readonly(
    config: &GlobalConfig,
    now_ms: i64,
) -> Option<OverageCreditGrantInfo> {
    if !is_anthropic_auth_enabled() {
        return None;
    }
    let org_id = config
        .oauth_account
        .as_ref()
        .and_then(|account| account.organization_uuid.as_deref())
        .filter(|org_id| !org_id.is_empty())?;
    let entry = cached_grant_entry(config, org_id)?;
    if now_ms.saturating_sub(entry.timestamp) > CACHE_TTL_MS {
        return None;
    }
    Some(entry.info)
}

/// Maps to: CC `services/api/overageCreditGrant.ts` `formatGrantAmount`.
pub fn format_grant_amount(info: &OverageCreditGrantInfo) -> Option<String> {
    let amount_minor_units = info.amount_minor_units?;
    let currency = info.currency.as_deref()?;
    if !currency.eq_ignore_ascii_case("USD") {
        return None;
    }
    let dollars = amount_minor_units as f64 / 100.0;
    if dollars.fract() == 0.0 {
        Some(format!("${}", dollars as i64))
    } else {
        Some(format!("${dollars:.2}"))
    }
}

pub fn ui_grant_info_from_cached_readonly(
    config: &GlobalConfig,
    now_ms: i64,
) -> Option<UiGrantInfo> {
    let info = get_cached_overage_credit_grant_readonly(config, now_ms)?;
    let amount = format_grant_amount(&info);
    Some(UiGrantInfo {
        available: info.available,
        granted: info.granted,
        amount,
    })
}

fn cached_grant_entry(config: &GlobalConfig, org_id: &str) -> Option<OverageCreditGrantCacheEntry> {
    let cache = config.overage_credit_grant_cache.as_ref()?;
    let by_org =
        serde_json::from_value::<HashMap<String, OverageCreditGrantCacheEntry>>(cache.clone())
            .ok()?;
    by_org.get(org_id).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::config::{AccountInfo, GlobalConfig};

    fn config_with_cache(entry: serde_json::Value) -> GlobalConfig {
        GlobalConfig {
            oauth_account: Some(AccountInfo {
                organization_uuid: Some("org-1".to_string()),
                ..Default::default()
            }),
            overage_credit_grant_cache: Some(serde_json::json!({ "org-1": entry })),
            ..Default::default()
        }
    }

    #[test]
    fn format_grant_amount_matches_official_usd_only_shape() {
        assert_eq!(
            format_grant_amount(&OverageCreditGrantInfo {
                amount_minor_units: Some(1_000),
                currency: Some("USD".to_string()),
                ..Default::default()
            })
            .as_deref(),
            Some("$10")
        );
        assert_eq!(
            format_grant_amount(&OverageCreditGrantInfo {
                amount_minor_units: Some(1_025),
                currency: Some("usd".to_string()),
                ..Default::default()
            })
            .as_deref(),
            Some("$10.25")
        );
        assert!(
            format_grant_amount(&OverageCreditGrantInfo {
                amount_minor_units: Some(1_000),
                currency: Some("EUR".to_string()),
                ..Default::default()
            })
            .is_none()
        );
    }

    #[test]
    fn cached_overage_grant_requires_auth_and_fresh_org_cache() {
        let config = config_with_cache(serde_json::json!({
            "timestamp": 1_000,
            "info": {
                "available": true,
                "eligible": true,
                "granted": false,
                "amount_minor_units": 1_000,
                "currency": "USD"
            }
        }));

        assert!(get_cached_overage_credit_grant_readonly(&config, 2_000).is_some());
        assert!(
            get_cached_overage_credit_grant_readonly(&config, 1_000 + CACHE_TTL_MS + 1).is_none()
        );
    }

    #[test]
    fn ui_grant_info_maps_cached_entry_to_logo_gate_shape() {
        let config = config_with_cache(serde_json::json!({
            "timestamp": 1_000,
            "info": {
                "available": true,
                "eligible": true,
                "granted": false,
                "amount_minor_units": 1_000,
                "currency": "USD"
            }
        }));

        let info = ui_grant_info_from_cached_readonly(&config, 2_000).expect("cached grant");
        assert!(info.available);
        assert!(!info.granted);
        assert_eq!(info.amount.as_deref(), Some("$10"));
    }
}
