//! GUI messages use the native client's confirmed room, never a broadcast socket.
use crate::riot::models::{cid_local_part, ChatChannel};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};
use xmltree::Element;

#[derive(Default)]
pub(super) struct Hub(Mutex<State>);
#[derive(Default)]
struct State {
    sequence: u64,
    connections: HashMap<u64, Connection>,
    pending: HashMap<String, Pending>,
}
struct Connection {
    sender: mpsc::Sender<Packet>,
    rooms: HashMap<String, (String, bool)>,
    valorant: bool,
}
struct Pending {
    connection: u64,
    room: String,
    body: String,
    reply: oneshot::Sender<Result<(), String>>,
}
pub(super) struct Packet {
    pub id: String,
    pub stanza: String,
}
pub(super) struct Lease {
    hub: Arc<Hub>,
    pub id: u64,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = self.hub.0.lock().unwrap();
        state.connections.remove(&self.id);
        state
            .pending
            .retain(|_, pending| pending.connection != self.id);
    }
}
struct Request<'a>(&'a Hub, String);
impl Drop for Request<'_> {
    fn drop(&mut self) {
        self.0 .0.lock().unwrap().pending.remove(&self.1);
    }
}
fn same_room(a: &str, b: &str) -> bool {
    let family = |cid: &str| {
        ["@ares-parties.", "@ares-pregame.", "@ares-coregame."]
            .into_iter()
            .position(|domain| cid.contains(domain))
    };
    family(a).is_some()
        && family(a) == family(b)
        && ChatChannel::EVERY
            .into_iter()
            .any(|channel| channel.matches_cid(a) && channel.matches_cid(b))
        && cid_local_part(a).eq_ignore_ascii_case(cid_local_part(b))
}
impl Hub {
    pub fn register(self: &Arc<Self>) -> (Lease, mpsc::Receiver<Packet>) {
        let (sender, receiver) = mpsc::channel(32);
        let mut state = self.0.lock().unwrap();
        state.sequence += 1;
        let id = state.sequence;
        state.connections.insert(
            id,
            Connection {
                sender,
                rooms: HashMap::new(),
                valorant: false,
            },
        );
        (
            Lease {
                hub: self.clone(),
                id,
            },
            receiver,
        )
    }
    pub fn reset(&self) {
        let mut state = self.0.lock().unwrap();
        state.connections.clear();
        state.pending.clear();
    }
    pub fn is_pending(&self, id: &str) -> bool {
        self.0.lock().unwrap().pending.contains_key(id)
    }
    // Record immediately before forwarding, so a fast server reply cannot race a join.
    // A failed write tears down the connection lease and removes these routes.
    pub fn outgoing(&self, connection: u64, stanza: &str) {
        let Ok(root) = Element::parse(stanza.as_bytes()) else {
            return;
        };
        let mut state = self.0.lock().unwrap();
        let Some(route) = state.connections.get_mut(&connection) else {
            return;
        };
        if super::xml::extract_valorant_version(stanza).is_some() {
            route.valorant = true;
        }
        if root.name != "presence" {
            return;
        }
        let Some((_, room, nick)) = super::xml::group_muc_target(stanza) else {
            return;
        };
        if root
            .attributes
            .get("type")
            .is_some_and(|kind| kind == "unavailable")
        {
            route.rooms.retain(|known, _| !same_room(known, &room));
            state.pending.retain(|_, pending| {
                pending.connection != connection || !same_room(&pending.room, &room)
            });
        } else if !nick.is_empty() && !root.attributes.contains_key("type") {
            route.rooms.entry(room).or_insert((nick, false));
        }
    }

    pub fn incoming(&self, connection: u64, stanza: &str) {
        let Ok(root) = Element::parse(stanza.as_bytes()) else {
            return;
        };
        let Some(from) = root.attributes.get("from") else {
            return;
        };
        let (room, nick) = from.split_once('/').unwrap_or((from, ""));
        let mut state = self.0.lock().unwrap();
        let Some(route) = state.connections.get_mut(&connection) else {
            return;
        };
        if root.name == "presence" {
            let known_room = route
                .rooms
                .keys()
                .find(|known| same_room(known, room))
                .cloned();
            if let Some(known_room) = known_room {
                let (own_nick, confirmed) = route.rooms.get_mut(&known_room).unwrap();
                let self_presence = own_nick == nick
                    || root.get_child("x").is_some_and(|x| {
                        x.children
                            .iter()
                            .filter_map(xmltree::XMLNode::as_element)
                            .any(|child| {
                                child.name == "status"
                                    && child
                                        .attributes
                                        .get("code")
                                        .is_some_and(|code| code == "110")
                            })
                    });
                let kind = root
                    .attributes
                    .get("type")
                    .map(String::as_str)
                    .unwrap_or("");
                if kind == "error" || (self_presence && kind == "unavailable") {
                    route.rooms.remove(&known_room);
                    state.pending.retain(|_, pending| {
                        pending.connection != connection || !same_room(&pending.room, room)
                    });
                } else if self_presence {
                    *confirmed = true;
                }
            }
        }
        if root.name != "message" {
            return;
        }
        let Some(id) = root.attributes.get("id") else {
            return;
        };
        let Some(pending) = state.pending.get(id) else {
            return;
        };
        if pending.connection != connection || !same_room(&pending.room, room) {
            return;
        }
        let kind = root
            .attributes
            .get("type")
            .map(String::as_str)
            .unwrap_or("");
        let result = if kind == "error" {
            Some(Err(
                "Riot rejected the group message. Check your game chat connection.".into(),
            ))
        } else if kind == "groupchat"
            && root
                .get_child("body")
                .and_then(Element::get_text)
                .is_some_and(|body| body == pending.body)
        {
            Some(Ok(()))
        } else {
            None
        };
        if let Some(result) = result {
            log::info!("GUI group message server confirmation: {}", result.is_ok());
            if let Some(pending) = state.pending.remove(id) {
                let _ = pending.reply.send(result);
            }
        }
    }
    pub async fn send(&self, cid: &str, body: &str) -> Result<(), String> {
        let (receiver, id) = {
            let mut state = self.0.lock().unwrap();
            let mut candidates: Vec<_> = state
                .connections
                .iter()
                .flat_map(|(id, connection)| {
                    connection
                        .rooms
                        .iter()
                        .filter(|(room, (_, confirmed))| *confirmed && same_room(room, cid))
                        .map(move |(room, _)| {
                            (
                                *id,
                                room.clone(),
                                connection.valorant,
                                connection.sender.clone(),
                            )
                        })
                })
                .collect();
            if candidates.iter().any(|candidate| candidate.2) {
                candidates.retain(|candidate| candidate.2);
            }
            if candidates.len() != 1 {
                log::info!(
                    "GUI group send unavailable: {} confirmed routes",
                    candidates.len()
                );
                return Err("No unique game chat connection for this room. Restart Riot through ValoUtils with game chat enabled, then rejoin the party or match.".into());
            }
            let (connection, room, _, sender) = candidates.remove(0);
            state.sequence += 1;
            let id = format!("valoutils-gui-{}", state.sequence);
            let stanza = super::groupchat_stanza_with_id(&room, body, &id);
            let (reply, receiver) = oneshot::channel();
            state.pending.insert(
                id.clone(),
                Pending {
                    connection,
                    room,
                    body: body.into(),
                    reply,
                },
            );
            if sender
                .try_send(Packet {
                    id: id.clone(),
                    stanza,
                })
                .is_err()
            {
                state.pending.remove(&id);
                return Err("Game chat connection is busy or closed.".into());
            }
            (receiver, id)
        };
        let _request = Request(self, id);
        match tokio::time::timeout(std::time::Duration::from_secs(10), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Game chat disconnected before delivery was confirmed.".into()),
            Err(_) => {
                Err("Delivery could not be confirmed. Check game chat before retrying.".into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ROOM: &str = "party@ares-parties.ap";
    #[test]
    fn gui_chat_room_aliases_preserve_phase_and_team() {
        assert!(same_room(
            "game-blue@ares-coregame.ap",
            "game-blue@ares-coregame.ap1.pvp.net"
        ));
        assert!(!same_room(
            "game-blue@ares-coregame.ap",
            "game-blue@ares-pregame.ap"
        ));
        assert!(!same_room(
            "game-blue@ares-coregame.ap",
            "game-red@ares-coregame.ap"
        ));
    }
    fn join(hub: &Hub, id: u64) {
        hub.outgoing(id, &format!(r#"<presence to="{ROOM}/me"/>"#));
        hub.incoming(id, &format!(r#"<presence from="party@ares-parties.ap1.pvp.net/me"><x xmlns="http://jabber.org/protocol/muc#user"><status code="110"/></x></presence>"#));
    }
    #[tokio::test]
    async fn gui_group_send_is_not_disabled_by_an_unrelated_relay_connection() {
        let hub = Arc::new(Hub::default());
        let (native, mut queue) = hub.register();
        let (_unrelated, mut other) = hub.register();
        join(&hub, native.id);
        let sending = hub.send("party@ares-parties.ap1.pvp.net", "hello");
        tokio::pin!(sending);
        tokio::select! { result = &mut sending => panic!("premature success: {result:?}"), packet = queue.recv() => {
            let packet = packet.unwrap();
            assert!(other.try_recv().is_err());
            assert!(packet.stanza.contains(ROOM));
            hub.incoming(native.id, &format!(r#"<message from="{ROOM}/me" type="groupchat" id="{}"><body>hello</body></message>"#, packet.id));
        }}
        assert!(sending.await.is_ok());
        assert!(hub.0.lock().unwrap().pending.is_empty());
    }
    #[tokio::test]
    async fn gui_chat_requires_confirmed_room_and_rejects_stale_or_ambiguous_routes() {
        let hub = Arc::new(Hub::default());
        let (first, _queue) = hub.register();
        assert!(hub.send(ROOM, "hello").await.is_err());
        join(&hub, first.id);
        assert!(hub.send("other@ares-parties.ap", "hello").await.is_err());
        assert!(hub.send("party@ares-coregame.ap", "hello").await.is_err());
        let (second, _other) = hub.register();
        join(&hub, second.id);
        assert!(hub.send(ROOM, "hello").await.is_err());
        drop(second);
        hub.incoming(
            first.id,
            &format!(r#"<presence from="{ROOM}/me" type="unavailable"/>"#),
        );
        assert!(hub.send(ROOM, "hello").await.is_err());
    }
    #[tokio::test]
    async fn gui_chat_reports_server_rejection_and_connection_close() {
        for reject in [true, false] {
            let hub = Arc::new(Hub::default());
            let (native, mut queue) = hub.register();
            join(&hub, native.id);
            let sending = hub.send(ROOM, "hello");
            tokio::pin!(sending);
            let packet = tokio::select! { result = &mut sending => panic!("premature: {result:?}"), packet = queue.recv() => packet.unwrap() };
            if reject {
                hub.incoming(
                    native.id,
                    &format!(
                        r#"<message from="{ROOM}" type="error" id="{}"/>"#,
                        packet.id
                    ),
                );
            } else {
                drop(native);
            }
            assert!(sending.await.is_err());
            assert!(hub.0.lock().unwrap().pending.is_empty());
        }
    }

    #[tokio::test]
    async fn gui_chat_does_not_accept_wrong_echo_and_cleans_cancelled_requests() {
        let hub = Arc::new(Hub::default());
        let (native, mut queue) = hub.register();
        hub.outgoing(
            native.id,
            &format!(
                r#"<presence to="{ROOM}/me"><x xmlns="http://jabber.org/protocol/muc"/></presence>"#
            ),
        );
        assert!(hub.send(ROOM, "hello").await.is_err());
        join(&hub, native.id);
        let mut sending = Box::pin(hub.send(ROOM, "hello"));
        let packet = tokio::select! { result = &mut sending => panic!("premature: {result:?}"), packet = queue.recv() => packet.unwrap() };
        hub.incoming(native.id, &format!(r#"<message from="{ROOM}/me" type="groupchat" id="{}"><body>different</body></message>"#, packet.id));
        assert!(hub.is_pending(&packet.id));
        drop(sending);
        assert!(!hub.is_pending(&packet.id));
        hub.reset();
        assert!(hub.send(ROOM, "hello").await.is_err());
        let (new_connection, _queue) = hub.register();
        drop(native);
        assert!(hub
            .0
            .lock()
            .unwrap()
            .connections
            .contains_key(&new_connection.id));
    }

    #[tokio::test]
    async fn gui_chat_cancels_queued_packets_when_leaving_room() {
        for incoming in [true, false] {
            let hub = Arc::new(Hub::default());
            let (native, mut queue) = hub.register();
            join(&hub, native.id);
            let mut sending = Box::pin(hub.send(ROOM, "hello"));
            let packet = tokio::select! { result = &mut sending => panic!("premature: {result:?}"), packet = queue.recv() => packet.unwrap() };
            if incoming {
                hub.incoming(
                    native.id,
                    &format!(r#"<presence from="{ROOM}/me" type="unavailable"/>"#),
                );
            } else {
                hub.outgoing(
                    native.id,
                    &format!(r#"<presence to="{ROOM}/me" type="unavailable"/>"#),
                );
            }
            assert!(!hub.is_pending(&packet.id));
            assert!(sending.await.is_err());
        }
    }
}
