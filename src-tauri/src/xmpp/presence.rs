use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use xmltree::{Element, XMLNode};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceSyncState {
    Syncing,
    Ready,
    Reconnecting,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendPresenceResource {
    pub puuid: String,
    pub resource: String,
    pub product: String,
    pub status: String,
    pub status_message: String,
    pub session_loop_state: String,
    pub private: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PresenceSignal {
    RosterReceived {
        generation: u64,
        friends: HashSet<String>,
    },
    Available {
        generation: u64,
        resource: FriendPresenceResource,
    },
    Unavailable {
        generation: u64,
        puuid: String,
        resource: String,
    },
    Disconnected {
        generation: u64,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceSnapshot {
    pub state: PresenceSyncState,
    pub generation: u64,
    pub friends: HashMap<String, Vec<FriendPresenceResource>>,
}

pub struct PresenceReducer {
    generation: u64,
    state: PresenceSyncState,
    roster: HashSet<String>,
    resources: HashMap<(String, String, String), FriendPresenceResource>,
}

impl Default for PresenceReducer {
    fn default() -> Self {
        Self {
            generation: 0,
            state: PresenceSyncState::Syncing,
            roster: HashSet::new(),
            resources: HashMap::new(),
        }
    }
}

impl PresenceReducer {
    pub fn begin_generation(&mut self, generation: u64) {
        self.generation = generation;
        self.state = PresenceSyncState::Syncing;
        self.roster.clear();
        self.resources.clear();
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn state(&self) -> PresenceSyncState {
        self.state
    }

    pub fn apply(&mut self, signal: PresenceSignal) -> bool {
        let signal_generation = match &signal {
            PresenceSignal::RosterReceived { generation, .. }
            | PresenceSignal::Available { generation, .. }
            | PresenceSignal::Unavailable { generation, .. }
            | PresenceSignal::Disconnected { generation } => *generation,
        };
        if signal_generation != self.generation {
            return false;
        }

        match signal {
            PresenceSignal::RosterReceived { friends, .. } => {
                self.roster = friends;
            }
            PresenceSignal::Available { resource, .. } => {
                let key = (
                    resource.puuid.clone(),
                    resource.resource.clone(),
                    resource.product.clone(),
                );
                self.resources.insert(key, resource);
            }
            PresenceSignal::Unavailable {
                puuid, resource, ..
            } => {
                self.resources.retain(|(item_puuid, item_resource, _), _| {
                    item_puuid != &puuid || item_resource != &resource
                });
            }
            PresenceSignal::Disconnected { .. } => {
                self.state = PresenceSyncState::Reconnecting;
                self.resources.clear();
            }
        }
        true
    }

    pub fn mark_ready(&mut self, generation: u64) -> bool {
        if generation != self.generation || self.state != PresenceSyncState::Syncing {
            return false;
        }
        self.state = PresenceSyncState::Ready;
        true
    }

    pub fn snapshot(&self) -> PresenceSnapshot {
        let mut friends: HashMap<String, Vec<FriendPresenceResource>> = HashMap::new();
        for resource in self.resources.values() {
            friends
                .entry(resource.puuid.clone())
                .or_default()
                .push(resource.clone());
        }
        for resources in friends.values_mut() {
            resources.sort_by(|left, right| {
                left.product
                    .cmp(&right.product)
                    .then_with(|| left.resource.cmp(&right.resource))
            });
        }
        PresenceSnapshot {
            state: self.state,
            generation: self.generation,
            friends,
        }
    }
}

fn child_text(element: &Element, name: &str) -> String {
    element
        .get_child(name)
        .and_then(Element::get_text)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn split_jid(value: &str) -> Option<(String, String)> {
    let (bare, resource) = value.split_once('/')?;
    let puuid = bare.split('@').next()?.trim().to_ascii_lowercase();
    if puuid.is_empty() || resource.trim().is_empty() {
        return None;
    }
    Some((puuid, resource.trim().to_string()))
}

fn decode_private(value: &str) -> Value {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return json!({});
    }
    base64::engine::general_purpose::STANDARD
        .decode(trimmed)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .or_else(|| serde_json::from_str(trimmed).ok())
        .unwrap_or_else(|| json!({}))
}

fn normalized_product(name: &str) -> Option<&'static str> {
    match name {
        "keystone" | "riot_client" => Some("riot_client"),
        "league_of_legends" => Some("league_of_legends"),
        "valorant" => Some("valorant"),
        _ => None,
    }
}

fn parse_roster(element: &Element, generation: u64) -> Option<PresenceSignal> {
    if element.name != "iq" || element.attributes.get("type").map(String::as_str) != Some("result")
    {
        return None;
    }
    let query = element.get_child("query")?;
    let namespace = query
        .namespace
        .as_deref()
        .or_else(|| query.attributes.get("xmlns").map(String::as_str));
    if !matches!(
        namespace,
        Some("jabber:iq:roster" | "jabber:iq:riotgames:roster")
    ) {
        return None;
    }
    let friends = query
        .children
        .iter()
        .filter_map(|node| match node {
            XMLNode::Element(item) if item.name == "item" => item
                .attributes
                .get("puuid")
                .or_else(|| item.attributes.get("jid"))
                .and_then(|value| value.split('@').next())
                .map(|value| value.to_ascii_lowercase()),
            _ => None,
        })
        .collect();
    Some(PresenceSignal::RosterReceived {
        generation,
        friends,
    })
}

fn parse_presence(element: &Element, generation: u64) -> Vec<PresenceSignal> {
    if element.name != "presence" {
        return Vec::new();
    }
    let Some((puuid, resource_name)) = element
        .attributes
        .get("from")
        .and_then(|value| split_jid(value))
    else {
        return Vec::new();
    };
    if element.attributes.get("type").map(String::as_str) == Some("unavailable") {
        return vec![PresenceSignal::Unavailable {
            generation,
            puuid,
            resource: resource_name,
        }];
    }

    let root_status = child_text(element, "show");
    let status_message = child_text(element, "status");
    let Some(games) = element.get_child("games") else {
        return Vec::new();
    };
    games
        .children
        .iter()
        .filter_map(|node| match node {
            XMLNode::Element(game) => Some(game),
            _ => None,
        })
        .filter_map(|game| {
            let product = normalized_product(&game.name)?;
            let game_status = child_text(game, "st");
            let status = if game_status.is_empty() {
                root_status.clone()
            } else {
                game_status
            };
            if !matches!(
                status.to_ascii_lowercase().as_str(),
                "chat" | "away" | "dnd" | "online"
            ) {
                return None;
            }
            let private = decode_private(&child_text(game, "p"));
            let session_loop_state = private
                .pointer("/matchPresenceData/sessionLoopState")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            Some(PresenceSignal::Available {
                generation,
                resource: FriendPresenceResource {
                    puuid: puuid.clone(),
                    resource: resource_name.clone(),
                    product: product.to_string(),
                    status,
                    status_message: status_message.clone(),
                    session_loop_state,
                    private,
                },
            })
        })
        .collect()
}

pub fn parse_presence_signals(xml: &str, generation: u64) -> Vec<PresenceSignal> {
    let wrapped = format!("<root>{xml}</root>");
    let Ok(root) = Element::parse(wrapped.as_bytes()) else {
        log::debug!("ignoring malformed XMPP presence/roster fragment");
        return Vec::new();
    };
    root.children
        .iter()
        .filter_map(|node| match node {
            XMLNode::Element(element) => Some(element),
            _ => None,
        })
        .flat_map(|element| {
            parse_roster(element, generation)
                .into_iter()
                .chain(parse_presence(element, generation))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn available(
        generation: u64,
        puuid: &str,
        resource_name: &str,
        product: &str,
    ) -> PresenceSignal {
        PresenceSignal::Available {
            generation,
            resource: FriendPresenceResource {
                puuid: puuid.into(),
                resource: resource_name.into(),
                product: product.into(),
                status: "chat".into(),
                status_message: String::new(),
                session_loop_state: String::new(),
                private: json!({}),
            },
        }
    }

    #[test]
    fn parses_supported_resources_and_valorant_state() {
        let private = base64::engine::general_purpose::STANDARD
            .encode(r#"{"matchPresenceData":{"sessionLoopState":"INGAME"}}"#);
        let xml = format!(
            r#"<presence from="friend@jp1.pvp.net/RC-1"><show>chat</show><status>ready</status><games><keystone><st>chat</st><s.p>keystone</s.p></keystone><league_of_legends><st>chat</st><s.p>league_of_legends</s.p></league_of_legends><valorant><st>chat</st><s.p>valorant</s.p><p>{private}</p></valorant></games></presence>"#
        );

        let events = parse_presence_signals(&xml, 7);
        let resources: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                PresenceSignal::Available { resource, .. } => Some(resource),
                _ => None,
            })
            .collect();

        assert_eq!(
            resources
                .iter()
                .map(|item| item.product.as_str())
                .collect::<Vec<_>>(),
            vec!["riot_client", "league_of_legends", "valorant"]
        );
        assert_eq!(
            resources
                .last()
                .map(|item| item.session_loop_state.as_str()),
            Some("INGAME")
        );
    }

    #[test]
    fn parses_unavailable_for_one_resource_and_roster_completion() {
        let xml = r#"<iq type="result"><query xmlns="jabber:iq:riotgames:roster"><item jid="friend@jp1.pvp.net" puuid="friend"/></query></iq><presence from="friend@jp1.pvp.net/RC-1" type="unavailable"/>"#;
        let events = parse_presence_signals(xml, 3);

        assert!(matches!(
            events.first(),
            Some(PresenceSignal::RosterReceived { generation: 3, .. })
        ));
        assert!(matches!(
            events.get(1),
            Some(PresenceSignal::Unavailable {
                generation: 3,
                puuid,
                resource
            }) if puuid == "friend" && resource == "RC-1"
        ));
    }

    #[test]
    fn ignores_mobile_and_offline_product_states() {
        let xml = r#"<presence from="friend@jp1.pvp.net/RC-1"><show>mobile</show><games><keystone><st>mobile</st></keystone><valorant><st>offline</st></valorant></games></presence>"#;

        assert!(parse_presence_signals(xml, 3).is_empty());
    }

    #[test]
    fn removes_only_the_unavailable_resource() {
        let mut reducer = PresenceReducer::default();
        reducer.begin_generation(4);
        reducer.apply(available(4, "friend", "RC-1", "riot_client"));
        reducer.apply(available(4, "friend", "VAL-2", "valorant"));
        reducer.apply(PresenceSignal::Unavailable {
            generation: 4,
            puuid: "friend".into(),
            resource: "RC-1".into(),
        });

        assert_eq!(reducer.snapshot().friends["friend"].len(), 1);
        assert_eq!(reducer.snapshot().friends["friend"][0].product, "valorant");
    }

    #[test]
    fn ignores_old_generation_and_invalidates_on_disconnect() {
        let mut reducer = PresenceReducer::default();
        reducer.begin_generation(9);
        reducer.apply(available(8, "friend", "old", "valorant"));
        assert!(reducer.snapshot().friends.is_empty());

        reducer.apply(available(9, "friend", "new", "valorant"));
        reducer.apply(PresenceSignal::Disconnected { generation: 9 });

        assert_eq!(reducer.snapshot().state, PresenceSyncState::Reconnecting);
        assert!(reducer.snapshot().friends.is_empty());
    }
}
