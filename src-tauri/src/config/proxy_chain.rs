use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Value};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChainNode {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub group: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProxyChain {
    pub group: String,
    pub nodes: Vec<ChainNode>,
}

impl ProxyChain {
    pub fn name(&self) -> String {
        format!(
            "链式 {} [{}]",
            self.nodes
                .iter()
                .map(|node| node.name.as_str())
                .collect::<Vec<_>>()
                .join(" ⇒ "),
            self.group
        )
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn str_key(s: &str) -> Value {
    Value::String(s.to_string())
}
fn value_str(s: impl Into<String>) -> Value {
    Value::String(s.into())
}
fn identity(group: &str) -> String {
    group.as_bytes().iter().map(|b| format!("{b:02x}")).collect()
}
fn as_map<'a>(v: &'a Value, message: &str) -> Result<&'a Mapping, String> {
    v.as_mapping().ok_or_else(|| message.into())
}
fn regex_literal(s: &str) -> String {
    regex::escape(s).replace('`', r"\x60")
}

// Enumerate possible leaves, not the current selection: the core resolves that
// selection for every connection, including nested/automatic groups.
fn collect_group_leaves(
    name: &str,
    target: &str,
    groups: &[Value],
    originals: &[Value],
    providers: &Mapping,
    seen: &mut HashSet<String>,
    nodes: &mut HashSet<String>,
    uses: &mut HashSet<String>,
) -> Result<(), String> {
    if name == target {
        return Err("A chain group cannot contain its target group (cycle)".into());
    }
    if !seen.insert(name.to_owned()) {
        return Ok(());
    }
    let group = groups
        .iter()
        .find(|g| g.get("name").and_then(Value::as_str) == Some(name))
        .ok_or_else(|| format!("Group not found: {name}"))?;
    if !matches!(
        group.get("type").and_then(Value::as_str),
        Some("select" | "fallback" | "url-test" | "load-balance")
    ) {
        return Err(format!("Unsupported chain group: {name}"));
    }
    let all = group.get("include-all").and_then(Value::as_bool) == Some(true);
    if all || group.get("include-all-proxies").and_then(Value::as_bool) == Some(true) {
        nodes.extend(
            originals
                .iter()
                .filter_map(|p| p.get("name").and_then(Value::as_str).map(str::to_owned)),
        );
    }
    if all || group.get("include-all-providers").and_then(Value::as_bool) == Some(true) {
        uses.extend(providers.keys().filter_map(Value::as_str).map(str::to_owned));
    }
    if let Some(entries) = group.get("use").and_then(Value::as_sequence) {
        uses.extend(entries.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    if let Some(entries) = group.get("proxies").and_then(Value::as_sequence) {
        for child in entries.iter().filter_map(Value::as_str) {
            if groups
                .iter()
                .any(|g| g.get("name").and_then(Value::as_str) == Some(child))
            {
                collect_group_leaves(child, target, groups, originals, providers, seen, nodes, uses)?;
            } else if originals
                .iter()
                .any(|p| p.get("name").and_then(Value::as_str) == Some(child))
            {
                nodes.insert(child.to_owned());
            }
        }
    }
    Ok(())
}

/// Construct a chain from independent outbound copies. Existing nodes stay untouched.
pub fn install(config: &mut Mapping, chain: &ProxyChain) -> Result<String, String> {
    let mut candidate = config.clone();
    let name = install_inner(&mut candidate, chain)?;
    *config = candidate;
    Ok(name)
}

fn install_inner(config: &mut Mapping, chain: &ProxyChain) -> Result<String, String> {
    if chain.nodes.len() < 2 {
        return Err("A chain needs at least two nodes".into());
    }
    if chain
        .nodes
        .iter()
        .map(|n| (&n.name, &n.provider))
        .collect::<HashSet<_>>()
        .len()
        != chain.nodes.len()
    {
        return Err("A chain cannot repeat a node".into());
    }
    let groups = config
        .get("proxy-groups")
        .and_then(Value::as_sequence)
        .ok_or("No proxy groups")?;
    let target = groups
        .iter()
        .find(|g| g.get("name").and_then(Value::as_str) == Some(&chain.group))
        .ok_or("Target group not found")?;
    if !matches!(
        target.get("type").and_then(Value::as_str),
        Some("select" | "url-test" | "fallback" | "load-balance")
    ) {
        return Err("Unsupported target group type".into());
    }
    let originals = config
        .get("proxies")
        .and_then(Value::as_sequence)
        .cloned()
        .unwrap_or_default();
    let providers = config
        .get("proxy-providers")
        .and_then(Value::as_mapping)
        .cloned()
        .unwrap_or_default();
    let mut occupied: HashSet<String> = originals
        .iter()
        .chain(groups.iter())
        .filter_map(|v| v.get("name").and_then(Value::as_str).map(str::to_owned))
        .collect();
    occupied.extend(providers.keys().filter_map(Value::as_str).map(str::to_owned));
    let id = identity(&chain.group);
    let final_name = chain.name();
    let mut copies = vec![];
    let mut new_groups = vec![];
    let mut new_providers = vec![];
    let mut hidden_names = vec![];
    let mut hidden_prefixes = vec![];
    let mut previous: Option<String> = None;
    for (idx, node) in chain.nodes.iter().enumerate() {
        let last = idx + 1 == chain.nodes.len();
        if node.group && node.provider.is_some() {
            return Err("A group cannot have a provider".into());
        }
        if node.group && previous.is_none() {
            collect_group_leaves(
                &node.name,
                &chain.group,
                groups,
                &originals,
                &providers,
                &mut HashSet::new(),
                &mut HashSet::new(),
                &mut HashSet::new(),
            )?;
            previous = Some(node.name.clone());
            continue;
        }
        let internal = format!("__cvr_chain_{id}_{idx}");
        let name = if last { final_name.clone() } else { internal.clone() };
        if !occupied.insert(name.clone()) {
            return Err(format!("Generated name already exists: {name}"));
        }
        if !last {
            hidden_names.push(name.clone());
        }
        if node.group {
            let mut leaves = HashSet::new();
            let mut uses = HashSet::new();
            collect_group_leaves(
                &node.name,
                &chain.group,
                groups,
                &originals,
                &providers,
                &mut HashSet::new(),
                &mut leaves,
                &mut uses,
            )?;
            let prefix = format!("{internal}__");
            let prev = previous.as_ref().ok_or("Missing previous hop")?;
            let mut members = vec![value_str(&node.name), value_str(prev), value_str("REJECT")];
            // A node may appear in several nested groups; copy each once.
            let mut leaves: Vec<_> = leaves.into_iter().collect();
            leaves.sort();
            for leaf in leaves {
                let source = originals
                    .iter()
                    .find(|p| p.get("name").and_then(Value::as_str) == Some(&leaf))
                    .ok_or("Missing source node")?;
                let mut copy = as_map(source, "Invalid source node")?.clone();
                let copy_name = format!("{prefix}{leaf}");
                if !occupied.insert(copy_name.clone()) {
                    return Err(format!("Duplicate chain node: {copy_name}"));
                }
                copy.insert(str_key("name"), value_str(&copy_name));
                copy.insert(str_key("dialer-proxy"), value_str(prev));
                copies.push(Value::Mapping(copy));
                members.push(value_str(copy_name));
            }
            let mut provider_ids = vec![];
            let mut uses: Vec<_> = uses.into_iter().collect();
            uses.sort();
            for (pidx, provider_name) in uses.iter().enumerate() {
                let mut provider = as_map(
                    providers
                        .get(provider_name)
                        .ok_or_else(|| format!("Provider not found: {provider_name}"))?,
                    "Invalid provider",
                )?
                .clone();
                let provider_id = format!("{internal}_provider_{pidx}");
                if !occupied.insert(provider_id.clone()) {
                    return Err("Duplicate chain provider".into());
                }
                if provider.get("type").and_then(Value::as_str) == Some("http") {
                    provider.insert(
                        str_key("path"),
                        value_str(format!("./proxy_providers/{provider_id}.yaml")),
                    );
                }
                let overrides = provider
                    .entry(str_key("override"))
                    .or_insert_with(|| Value::Mapping(Mapping::new()))
                    .as_mapping_mut()
                    .ok_or("Invalid provider override")?;
                if overrides.contains_key("override-expr") {
                    return Err("Provider override-expr is not supported for chains".into());
                }
                let old_prefix = overrides.get("additional-prefix").and_then(Value::as_str).unwrap_or("");
                overrides.insert(str_key("additional-prefix"), value_str(format!("{prefix}{old_prefix}")));
                overrides.insert(str_key("dialer-proxy"), value_str(prev));
                new_providers.push((str_key(&provider_id), Value::Mapping(provider)));
                provider_ids.push(value_str(provider_id));
            }
            let mut mirror = Mapping::new();
            mirror.insert(str_key("name"), value_str(&name));
            mirror.insert(str_key("type"), value_str("chain-mirror"));
            mirror.insert(str_key("hidden"), true.into());
            mirror.insert(str_key("mirror-source"), value_str(&node.name));
            mirror.insert(str_key("mirror-prefix"), value_str(&prefix));
            mirror.insert(str_key("mirror-direct"), value_str(prev));
            mirror.insert(str_key("empty-fallback"), value_str("REJECT"));
            mirror.insert(str_key("proxies"), Value::Sequence(members));
            if !provider_ids.is_empty() {
                mirror.insert(str_key("use"), Value::Sequence(provider_ids));
            }
            new_groups.push(Value::Mapping(mirror));
            hidden_prefixes.push(prefix);
        } else if let Some(provider_name) = &node.provider {
            let mut provider = as_map(
                providers
                    .get(provider_name)
                    .ok_or_else(|| format!("Provider not found: {provider_name}"))?,
                "Invalid provider",
            )?
            .clone();
            let provider_id = format!("{internal}_provider");
            if !occupied.insert(provider_id.clone()) {
                return Err(format!("Provider name already exists: {provider_id}"));
            }
            if provider.get("type").and_then(Value::as_str) == Some("http") {
                provider.insert(
                    str_key("path"),
                    value_str(format!("./proxy_providers/{provider_id}.yaml")),
                );
            }
            let overrides = provider
                .entry(str_key("override"))
                .or_insert_with(|| Value::Mapping(Mapping::new()))
                .as_mapping_mut()
                .ok_or("Invalid provider override")?;
            if overrides.contains_key("override-expr") {
                return Err("Provider override-expr is not supported for chains".into());
            }
            let prefix = format!("{internal}__");
            let old_prefix = overrides.get("additional-prefix").and_then(Value::as_str).unwrap_or("");
            overrides.insert(str_key("additional-prefix"), value_str(format!("{prefix}{old_prefix}")));
            if let Some(previous) = &previous {
                overrides.insert(str_key("dialer-proxy"), value_str(previous));
            }
            let mut group = Mapping::new();
            group.insert(str_key("name"), value_str(&name));
            group.insert(str_key("type"), value_str("select"));
            group.insert(str_key("hidden"), true.into());
            group.insert(str_key("use"), Value::Sequence(vec![value_str(&provider_id)]));
            group.insert(
                str_key("filter"),
                value_str(format!("^{}$", regex_literal(&format!("{prefix}{}", node.name)))),
            );
            group.insert(str_key("empty-fallback"), value_str("REJECT"));
            new_groups.push(Value::Mapping(group));
            new_providers.push((str_key(&provider_id), Value::Mapping(provider)));
            hidden_prefixes.push(prefix);
        } else {
            let source = originals
                .iter()
                .find(|p| p.get("name").and_then(Value::as_str) == Some(&node.name))
                .ok_or_else(|| format!("Node not found: {}", node.name))?;
            let mut proxy = as_map(source, "Invalid proxy")?.clone();
            proxy.insert(str_key("name"), value_str(&name));
            if let Some(previous) = &previous {
                proxy.insert(str_key("dialer-proxy"), value_str(previous));
            }
            copies.push(Value::Mapping(proxy));
        }
        previous = Some(name);
    }
    if !copies.is_empty() {
        config
            .entry(str_key("proxies"))
            .or_insert_with(|| Value::Sequence(vec![]))
            .as_sequence_mut()
            .ok_or("Invalid proxies")?
            .extend(copies);
    }
    if !new_providers.is_empty() {
        let map = config
            .entry(str_key("proxy-providers"))
            .or_insert_with(|| Value::Mapping(Mapping::new()))
            .as_mapping_mut()
            .ok_or("Invalid providers")?;
        for (key, value) in new_providers {
            map.insert(key, value);
        }
    }
    let groups = config
        .get_mut("proxy-groups")
        .and_then(Value::as_sequence_mut)
        .ok_or("Invalid groups")?;
    // Include-all groups must not accidentally pick generated chain internals.
    for value in groups.iter_mut() {
        let group = value.as_mapping_mut().ok_or("Invalid group")?;
        let is_target = group.get("name").and_then(Value::as_str) == Some(&chain.group);
        let includes_all = ["include-all", "include-all-proxies", "include-all-providers"]
            .iter()
            .any(|k| group.get(*k).and_then(Value::as_bool) == Some(true));
        if includes_all {
            let mut excluded = hidden_names.clone();
            if !is_target {
                excluded.push(final_name.clone());
            }
            let pattern = excluded
                .iter()
                .map(|n| format!("^{}$", regex_literal(n)))
                .chain(hidden_prefixes.iter().map(|p| format!("^{}", regex_literal(p))))
                .collect::<Vec<_>>()
                .join("|");
            let old = group.get("exclude-filter").and_then(Value::as_str).unwrap_or("");
            group.insert(
                str_key("exclude-filter"),
                value_str(if old.is_empty() {
                    pattern
                } else {
                    format!("{old}`{pattern}")
                }),
            );
        }
        if is_target {
            group
                .entry(str_key("proxies"))
                .or_insert_with(|| Value::Sequence(vec![]))
                .as_sequence_mut()
                .ok_or("Invalid target proxies")?
                .push(value_str(&final_name));
        }
    }
    groups.extend(new_groups);
    Ok(final_name)
}

/// Keep a missing chain from silently falling back to direct traffic.
pub fn install_reject_stub(config: &mut Mapping, chain: &ProxyChain) {
    let name = chain.name();
    let Some(groups) = config.get_mut("proxy-groups").and_then(Value::as_sequence_mut) else {
        return;
    };
    if groups
        .iter()
        .any(|g| g.get("name").and_then(Value::as_str) == Some(&name))
    {
        return;
    }
    let Some(group) = groups
        .iter_mut()
        .find(|g| g.get("name").and_then(Value::as_str) == Some(&chain.group))
        .and_then(Value::as_mapping_mut)
    else {
        return;
    };
    let Some(members) = group
        .entry(str_key("proxies"))
        .or_insert_with(|| Value::Sequence(vec![]))
        .as_sequence_mut()
    else {
        return;
    };
    members.push(value_str(&name));
    let mut blocked = Mapping::new();
    blocked.insert(str_key("name"), value_str(name));
    blocked.insert(str_key("type"), value_str("select"));
    blocked.insert(str_key("hidden"), true.into());
    blocked.insert(str_key("proxies"), Value::Sequence(vec![value_str("REJECT")]));
    groups.push(Value::Mapping(blocked));
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GroupMode {
    Select,
    Fallback,
    UrlTest,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GroupPolicy {
    pub group: String,
    pub mode: GroupMode,
    pub candidates: Vec<String>,
    pub disabled: Vec<String>,
    #[serde(default)]
    pub universe: Vec<PolicyNode>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PolicyNode {
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// Apply a snapshot of the UI's filtered candidates to one group only.
pub fn apply_group_policy(
    config: &mut Mapping,
    group_name: &str,
    mode: GroupMode,
    candidates: &[String],
    disabled: &[String],
) -> Result<(), String> {
    let allowed: Vec<&String> = candidates
        .iter()
        .filter(|name| mode == GroupMode::Select || !disabled.contains(name))
        .collect();
    if allowed.is_empty() {
        return Err("No eligible nodes remain".into());
    }
    let mut draft = config.clone();
    let all_proxy_names: Vec<String> = draft
        .get("proxies")
        .and_then(Value::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(|node| node.get("name").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let all_provider_names: Vec<String> = draft
        .get("proxy-providers")
        .and_then(Value::as_mapping)
        .into_iter()
        .flat_map(|p| p.keys())
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let groups = draft
        .get_mut("proxy-groups")
        .and_then(Value::as_sequence_mut)
        .ok_or("No proxy groups in runtime configuration")?;
    let group = groups
        .iter_mut()
        .find(|g| g.get("name").and_then(Value::as_str) == Some(group_name))
        .and_then(Value::as_mapping_mut)
        .ok_or("Target proxy group not found")?;
    let all = group.get("include-all").and_then(Value::as_bool).unwrap_or(false);
    let add_proxies = all
        || group
            .get("include-all-proxies")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let add_providers = all
        || group
            .get("include-all-providers")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if add_providers {
        group.insert(
            str_key("use"),
            Value::Sequence(all_provider_names.into_iter().map(value_str).collect()),
        );
    }
    if add_proxies {
        let proxies = group
            .entry(str_key("proxies"))
            .or_insert_with(|| Value::Sequence(vec![]))
            .as_sequence_mut()
            .ok_or("Invalid proxy list")?;
        for name in all_proxy_names {
            if allowed.iter().any(|v| **v == name) && !proxies.iter().any(|v| v.as_str() == Some(&name)) {
                proxies.push(value_str(name));
            }
        }
    }
    for key in ["include-all", "include-all-proxies", "include-all-providers"] {
        group.remove(key);
    }
    if let Some(items) = group.get_mut("proxies") {
        let items = items.as_sequence_mut().ok_or("Invalid proxy list")?;
        items.retain(|item| {
            item.as_str()
                .is_some_and(|name| allowed.iter().any(|v| v.as_str() == name))
        });
    }
    if group.get("use").is_some() {
        let pattern = format!(
            "^(?:{})$",
            allowed
                .iter()
                .map(|name| regex::escape(name).replace('`', r"\x60"))
                .collect::<Vec<_>>()
                .join("|")
        );
        group.insert("filter".into(), pattern.into());
    }
    group.insert(
        "type".into(),
        match mode {
            GroupMode::Select => "select",
            GroupMode::Fallback => "fallback",
            GroupMode::UrlTest => "url-test",
        }
        .into(),
    );
    group.insert("empty-fallback".into(), "REJECT".into());
    *config = draft;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn node(name: &str, provider: Option<&str>) -> ChainNode {
        ChainNode {
            name: name.into(),
            provider: provider.map(str::to_owned),
            group: false,
        }
    }
    fn group(name: &str) -> ChainNode {
        ChainNode {
            name: name.into(),
            provider: None,
            group: true,
        }
    }
    #[test]
    fn group_chain_mirrors_all_possible_leaves_and_preserves_source_groups() {
        let mut cfg: Mapping = serde_yaml_ng::from_str("proxies: [{name: A1, type: socks5}, {name: B1, type: socks5}, {name: B2, type: socks5}]\nproxy-groups: [{name: Rule, type: select, proxies: [A, B]}, {name: A, type: select, proxies: [A1]}, {name: B, type: select, proxies: [Nested, B2]}, {name: Nested, type: select, proxies: [B1]}]").unwrap();
        let before = cfg.clone();
        let name = install(
            &mut cfg,
            &ProxyChain {
                group: "Rule".into(),
                nodes: vec![group("A"), group("B")],
            },
        )
        .unwrap();
        for idx in 1..4 {
            assert_eq!(cfg["proxy-groups"][idx], before["proxy-groups"][idx]);
        }
        let mirror = cfg["proxy-groups"].as_sequence().unwrap().last().unwrap();
        assert_eq!(mirror["type"].as_str(), Some("chain-mirror"));
        assert_eq!(mirror["mirror-source"].as_str(), Some("B"));
        assert_eq!(mirror["mirror-direct"].as_str(), Some("A"));
        assert_eq!(mirror["name"].as_str(), Some(name.as_str()));
        for leaf in ["B1", "B2"] {
            assert!(cfg["proxies"].as_sequence().unwrap().iter().any(|p| p["name"]
                .as_str()
                .unwrap()
                .ends_with(&format!("__{leaf}"))
                && p["dialer-proxy"].as_str() == Some("A")));
        }
    }
    #[test]
    fn group_chain_rejects_target_cycles_without_modification() {
        let mut cfg: Mapping = serde_yaml_ng::from_str("proxies: [{name: P, type: socks5}]\nproxy-groups: [{name: Rule, type: select, proxies: [A, B]}, {name: A, type: select, proxies: [P]}, {name: B, type: select, proxies: [Rule]}]").unwrap();
        let before = cfg.clone();
        assert!(install(
            &mut cfg,
            &ProxyChain {
                group: "Rule".into(),
                nodes: vec![group("A"), group("B")]
            }
        )
        .is_err());
        assert_eq!(cfg, before);
    }
    #[test]
    fn static_chain_isolated() {
        let mut cfg: Mapping = serde_yaml_ng::from_str("proxies: [{name: A, type: socks5}, {name: B, type: socks5}]\nproxy-groups: [{name: Supply, type: select, proxies: [A,B]}, {name: Google, type: select, proxies: [Supply]}]").unwrap();
        let orig = cfg.clone();
        let name = install(
            &mut cfg,
            &ProxyChain {
                group: "Supply".into(),
                nodes: vec![node("A", None), node("B", None)],
            },
        )
        .unwrap();
        assert_eq!(cfg["proxies"][0], orig["proxies"][0]);
        assert_eq!(cfg["proxies"][1], orig["proxies"][1]);
        assert_eq!(cfg["proxy-groups"][1], orig["proxy-groups"][1]);
        assert_eq!(cfg["proxy-groups"][0]["proxies"][2].as_str(), Some(name.as_str()));
        assert_eq!(cfg["proxies"][3]["dialer-proxy"], cfg["proxies"][2]["name"]);
    }
    #[test]
    fn provider_chain_and_rollback() {
        let mut cfg:Mapping=serde_yaml_ng::from_str("proxy-providers: {airport: {type: file, path: ./p.yaml}}\nproxy-groups: [{name: Supply, type: select, use: [airport]}]").unwrap();
        let original = cfg.clone();
        let invalid = ProxyChain {
            group: "Supply".into(),
            nodes: vec![node("A", Some("airport")), node("B", Some("missing"))],
        };
        assert!(install(&mut cfg, &invalid).is_err());
        assert_eq!(cfg, original);
        let valid = ProxyChain {
            group: "Supply".into(),
            nodes: vec![node("A", Some("airport")), node("B", Some("airport"))],
        };
        let result = install(&mut cfg, &valid).unwrap();
        assert_eq!(cfg["proxy-groups"][0]["proxies"][0].as_str(), Some(result.as_str()));
        assert_eq!(cfg["proxy-groups"].as_sequence().unwrap().len(), 3);
    }
    #[test]
    fn policy_excludes_disabled_and_other_group_unchanged() {
        let mut cfg:Mapping=serde_yaml_ng::from_str("proxy-groups: [{name: Supply, type: select, proxies: [A,B], use: [airport]}, {name: Google, type: select, proxies: [Supply]}]").unwrap();
        let orig = cfg.clone();
        apply_group_policy(
            &mut cfg,
            "Supply",
            GroupMode::Fallback,
            &["A".into(), "B".into()],
            &["B".into()],
        )
        .unwrap();
        assert_eq!(cfg["proxy-groups"][0]["type"].as_str(), Some("fallback"));
        assert_eq!(cfg["proxy-groups"][0]["proxies"].as_sequence().unwrap().len(), 1);
        assert_eq!(cfg["proxy-groups"][1], orig["proxy-groups"][1]);
    }
    #[test]
    fn selector_keeps_disabled_available_and_automatic_excludes_them() {
        let config: Mapping =
            serde_yaml_ng::from_str("proxy-groups: [{name: X, type: select, proxies: [A, B]}]").unwrap();
        let names = ["A".into(), "B".into()];
        let disabled = ["B".into()];
        for (mode, expected) in [
            (GroupMode::Select, vec!["A", "B"]),
            (GroupMode::Fallback, vec!["A"]),
            (GroupMode::UrlTest, vec!["A"]),
        ] {
            let mut draft = config.clone();
            apply_group_policy(&mut draft, "X", mode, &names, &disabled).unwrap();
            let actual: Vec<&str> = draft["proxy-groups"][0]["proxies"]
                .as_sequence()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect();
            assert_eq!(actual, expected);
        }
    }
    #[test]
    fn include_all_excludes_every_node_of_cloned_provider() {
        let mut cfg: Mapping = serde_yaml_ng::from_str("proxy-providers: {airport: {type: file, path: ./p.yaml}}\nproxy-groups: [{name: Supply, type: select, use: [airport]}, {name: Other, type: select, include-all-providers: true}]").unwrap();
        install(
            &mut cfg,
            &ProxyChain {
                group: "Supply".into(),
                nodes: vec![node("A", Some("airport")), node("B", Some("airport"))],
            },
        )
        .unwrap();
        let filter = cfg["proxy-groups"][1]["exclude-filter"].as_str().unwrap();
        assert!(filter.contains("^__cvr_chain_"));
        let pattern = regex::Regex::new(filter).unwrap();
        assert!(pattern.is_match("__cvr_chain_537570706c79_0__UNRELATED_PROVIDER_NODE"));
        assert!(!pattern.is_match("UNRELATED_PROVIDER_NODE"));
    }
    #[test]
    fn policy_roundtrips_node_metadata() {
        let yaml = "group: X\nmode: url-test\ncandidates: [A]\ndisabled: []\nuniverse: [{name: A, type: Socks5, provider: airport}]";
        let policy: GroupPolicy = serde_yaml_ng::from_str(yaml).unwrap();
        assert_eq!(policy.universe[0].provider.as_deref(), Some("airport"));
        let encoded = serde_yaml_ng::to_string(&policy).unwrap();
        assert_eq!(serde_yaml_ng::from_str::<GroupPolicy>(&encoded).unwrap(), policy);
    }
}
