const MATCH_END_CONNECTED_MISSES: u8 = 3;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PhaseObservation {
    pub connected: bool,
    pub pregame_id: Option<String>,
    pub match_id: Option<String>,
    /// What the game last said about itself over XMPP. Every field is empty
    /// when the relay is not running to carry that presence.
    pub presence: PresenceMatchState,
}

/// The match-related part of the game's own presence payload.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PresenceMatchState {
    /// `MENUS` is the game saying the match is over, which beats waiting three
    /// polls for core-game to 404.
    pub session_loop_state: Option<String>,
    pub queue_id: Option<String>,
    pub ally_score: Option<u32>,
    pub enemy_score: Option<u32>,
}

/// What a mode is played to, and whether winning it takes a two-round lead.
///
/// Every mode here is decided by a two-sided score, because that is all this
/// presence carries. Deathmatch is a race to 30 kills but it is free-for-all:
/// the winner is whichever player is highest, and an ally/enemy pair cannot
/// say who that is. Team Deathmatch, Escalation and Replication finish on
/// points or levels the pair does not describe either. All of them fall back
/// to the presence and poll rules rather than being guessed at from a score
/// that is not about them.
fn round_target(queue_id: &str) -> Option<(u32, bool)> {
    match queue_id.trim().to_ascii_lowercase().as_str() {
        // 13 wins it, except from 12-12, where overtime runs until someone is
        // two clear: 13-11 is over, 13-12 is not, 14-12 is, and a level score
        // keeps going for as many pairs as it takes.
        "competitive" | "unrated" | "premier" => Some((13, true)),
        "swiftplay" => Some((5, false)),
        "spikerush" => Some((4, false)),
        _ => None,
    }
}

/// Whether the score on screen has already decided the match.
///
/// A custom game reports an empty queue id and can be set to any round count,
/// so it is deliberately not decided here.
pub fn match_is_decided(presence: &PresenceMatchState) -> bool {
    let (Some(ally), Some(enemy)) = (presence.ally_score, presence.enemy_score) else {
        return false;
    };
    let Some(queue_id) = presence.queue_id.as_deref() else {
        return false;
    };
    let Some((target, needs_two_clear)) = round_target(queue_id) else {
        return false;
    };
    let leader = ally.max(enemy);
    let trailer = ally.min(enemy);
    leader >= target && (!needs_two_clear || leader - trailer >= 2)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LifecycleTransition {
    PregameStarted { pregame_id: String },
    MatchStarted { match_id: String },
    MatchEnded { match_id: String },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LifecycleTracker {
    last_pregame_id: Option<String>,
    active_match_id: Option<String>,
    connected_match_misses: u8,
    /// A match already reported as ended. The scoreline can end a match while
    /// core-game still serves its id, and without this the very next poll
    /// would read that id as a brand new match starting.
    completed_match_id: Option<String>,
}

impl LifecycleTracker {
    pub fn observe(&mut self, observation: PhaseObservation) -> Vec<LifecycleTransition> {
        if !observation.connected {
            return Vec::new();
        }

        let pregame_id = normalize_phase_id(observation.pregame_id.as_deref());
        let match_id = normalize_phase_id(observation.match_id.as_deref());
        let mut transitions = Vec::new();

        if let Some(pregame_id) = pregame_id {
            if self.last_pregame_id.as_deref() != Some(pregame_id.as_str()) {
                self.last_pregame_id = Some(pregame_id.clone());
                transitions.push(LifecycleTransition::PregameStarted { pregame_id });
            }
        }

        match (self.active_match_id.clone(), match_id) {
            (Some(active), Some(current)) if active != current => {
                transitions.push(LifecycleTransition::MatchEnded { match_id: active });
                self.active_match_id = Some(current.clone());
                self.connected_match_misses = 0;
                transitions.push(LifecycleTransition::MatchStarted { match_id: current });
            }
            (Some(active), Some(_)) => {
                self.connected_match_misses = 0;
                // Still in the match as far as core-game is concerned, but the
                // scoreboard has already settled it, so this is the moment the
                // match ended rather than whenever the client reaches a menu.
                if match_is_decided(&observation.presence) {
                    transitions.push(LifecycleTransition::MatchEnded {
                        match_id: active.clone(),
                    });
                    self.completed_match_id = Some(active);
                    self.active_match_id = None;
                }
            }
            (Some(active), None) => {
                // The game announcing MENUS is the end of the match, stated by
                // the client itself. Without the relay there is no presence to
                // read, so the miss count still carries the decision.
                if says_out_of_match(observation.presence.session_loop_state.as_deref()) {
                    transitions.push(LifecycleTransition::MatchEnded {
                        match_id: active.clone(),
                    });
                    self.completed_match_id = Some(active);
                    self.active_match_id = None;
                    self.connected_match_misses = 0;
                } else {
                    self.connected_match_misses = self.connected_match_misses.saturating_add(1);
                    if self.connected_match_misses >= MATCH_END_CONNECTED_MISSES {
                        transitions.push(LifecycleTransition::MatchEnded {
                            match_id: active.clone(),
                        });
                        self.completed_match_id = Some(active);
                        self.active_match_id = None;
                        self.connected_match_misses = 0;
                    }
                }
            }
            // A match this tracker has already ended keeps its id in core-game
            // until the client leaves, and that is not a new match.
            (None, Some(current)) if self.completed_match_id.as_deref() == Some(&current) => {
                self.connected_match_misses = 0;
            }
            (None, Some(current)) => {
                self.active_match_id = Some(current.clone());
                self.connected_match_misses = 0;
                transitions.push(LifecycleTransition::MatchStarted { match_id: current });
            }
            (None, None) => {
                self.connected_match_misses = 0;
            }
        }

        transitions
    }
}

/// Whether presence puts the client outside a match.
///
/// Only `MENUS` counts. An unknown or absent state says nothing, and reading it
/// as "no match" would end a match early on every future value Riot adds.
fn says_out_of_match(session_loop_state: Option<&str>) -> bool {
    session_loop_state
        .map(str::trim)
        .is_some_and(|state| state.eq_ignore_ascii_case("MENUS"))
}

fn normalize_phase_id(value: Option<&str>) -> Option<String> {
    let bare = value?.trim().split('@').next()?.trim();
    if bare.is_empty() {
        return None;
    }
    let lower = bare.to_ascii_lowercase();
    for suffix in ["-blue", "-red", "-all"] {
        if lower.ends_with(suffix) {
            let normalized = bare[..bare.len() - suffix.len()].trim();
            return (!normalized.is_empty()).then(|| normalized.to_string());
        }
    }
    Some(bare.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connected(pregame_id: Option<&str>, match_id: Option<&str>) -> PhaseObservation {
        PhaseObservation {
            connected: true,
            pregame_id: pregame_id.map(str::to_string),
            match_id: match_id.map(str::to_string),
            // No relay: the poll-only path, which is what most of these cover.
            presence: PresenceMatchState::default(),
        }
    }

    fn connected_in_state(match_id: Option<&str>, state: &str) -> PhaseObservation {
        PhaseObservation {
            presence: PresenceMatchState {
                session_loop_state: Some(state.to_string()),
                ..PresenceMatchState::default()
            },
            ..connected(None, match_id)
        }
    }

    fn connected_at_score(
        match_id: &str,
        queue_id: &str,
        ally: u32,
        enemy: u32,
    ) -> PhaseObservation {
        PhaseObservation {
            presence: PresenceMatchState {
                session_loop_state: Some("INGAME".into()),
                queue_id: Some(queue_id.into()),
                ally_score: Some(ally),
                enemy_score: Some(enemy),
            },
            ..connected(None, Some(match_id))
        }
    }

    #[test]
    fn thirteen_ends_a_standard_match_but_not_from_twelve_all() {
        for queue_id in ["competitive", "unrated", "premier"] {
            let mut tracker = LifecycleTracker::default();
            tracker.observe(connected_at_score("m", queue_id, 1, 0));
            // 12-12 goes to overtime, and 13-12 is still not two clear.
            assert_eq!(
                tracker.observe(connected_at_score("m", queue_id, 12, 12)),
                Vec::new(),
                "{queue_id}"
            );
            assert_eq!(
                tracker.observe(connected_at_score("m", queue_id, 13, 12)),
                Vec::new(),
                "{queue_id}"
            );
            assert_eq!(
                tracker.observe(connected_at_score("m", queue_id, 14, 12)),
                vec![LifecycleTransition::MatchEnded {
                    match_id: "m".into()
                }],
                "{queue_id}"
            );
        }
    }

    #[test]
    fn overtime_runs_until_one_side_is_two_clear_however_long_that_takes() {
        // From 12-12 every pair of rounds can level the score again, so the
        // only thing that ends it is a two-round lead, whenever it arrives.
        let mut tracker = LifecycleTracker::default();
        tracker.observe(connected_at_score("m", "competitive", 12, 12));
        for (ally, enemy) in [(13, 12), (13, 13), (14, 13), (14, 14), (15, 14)] {
            assert_eq!(
                tracker.observe(connected_at_score("m", "competitive", ally, enemy)),
                Vec::new(),
                "{ally}-{enemy}"
            );
        }
        assert_eq!(
            tracker.observe(connected_at_score("m", "competitive", 16, 14)),
            vec![LifecycleTransition::MatchEnded {
                match_id: "m".into()
            }]
        );
    }

    #[test]
    fn free_for_all_deathmatch_is_never_decided_from_a_two_sided_score() {
        // 30 kills wins a Deathmatch, but whose 30 is not in an ally/enemy
        // pair: the leader may be any of the twelve players. Ending on this
        // score would call the match at the wrong moment, or for the wrong
        // person, so it stays with the presence and poll rules.
        for score in [0, 29, 30, 99] {
            assert!(
                !match_is_decided(&PresenceMatchState {
                    session_loop_state: None,
                    queue_id: Some("deathmatch".into()),
                    ally_score: Some(score),
                    enemy_score: Some(0),
                }),
                "{score}"
            );
        }
    }

    #[test]
    fn a_decided_match_ends_once_and_does_not_restart_on_the_next_poll() {
        let mut tracker = LifecycleTracker::default();
        assert_eq!(
            tracker.observe(connected_at_score("m", "competitive", 12, 5)),
            vec![LifecycleTransition::MatchStarted {
                match_id: "m".into()
            }]
        );
        assert_eq!(
            tracker.observe(connected_at_score("m", "competitive", 13, 5)),
            vec![LifecycleTransition::MatchEnded {
                match_id: "m".into()
            }]
        );
        // core-game keeps serving the id until the client leaves; that is the
        // same match, not a new one, and it must not end twice either.
        assert_eq!(
            tracker.observe(connected_at_score("m", "competitive", 13, 5)),
            Vec::new()
        );
        assert_eq!(tracker.observe(connected(None, None)), Vec::new());
        // A genuinely new match still starts.
        assert_eq!(
            tracker.observe(connected_at_score("m2", "competitive", 1, 0)),
            vec![LifecycleTransition::MatchStarted {
                match_id: "m2".into()
            }]
        );
    }

    #[test]
    fn short_modes_finish_at_their_own_round_count() {
        // Swiftplay is played to 5 and Spike Rush to 4, neither with overtime,
        // so a one-round lead at the target ends them.
        let mut swiftplay = LifecycleTracker::default();
        swiftplay.observe(connected_at_score("m", "swiftplay", 4, 4));
        assert_eq!(
            swiftplay.observe(connected_at_score("m", "swiftplay", 5, 4)),
            vec![LifecycleTransition::MatchEnded {
                match_id: "m".into()
            }]
        );

        let mut rush = LifecycleTracker::default();
        rush.observe(connected_at_score("m", "spikerush", 3, 3));
        assert_eq!(
            rush.observe(connected_at_score("m", "spikerush", 4, 3)),
            vec![LifecycleTransition::MatchEnded {
                match_id: "m".into()
            }]
        );
        // A standard match is nowhere near over at those scores.
        assert!(!match_is_decided(&PresenceMatchState {
            queue_id: Some("competitive".into()),
            ally_score: Some(5),
            enemy_score: Some(4),
            session_loop_state: None,
        }));
    }

    #[test]
    fn modes_and_payloads_that_do_not_describe_a_round_count_decide_nothing() {
        let scored = |queue_id: Option<&str>, ally, enemy| PresenceMatchState {
            session_loop_state: None,
            queue_id: queue_id.map(str::to_string),
            ally_score: ally,
            enemy_score: enemy,
        };
        // Kills, points and levels are not this scoreline, and a custom game
        // reports an empty queue id with any round count the host picked.
        for queue_id in ["deathmatch", "hurm", "ggteam", "onefa", "snowball", ""] {
            assert!(
                !match_is_decided(&scored(Some(queue_id), Some(99), Some(0))),
                "{queue_id}"
            );
        }
        // No relay, or a presence that carried no score at all.
        assert!(!match_is_decided(&scored(None, Some(13), Some(0))));
        assert!(!match_is_decided(&scored(
            Some("competitive"),
            None,
            Some(0)
        )));
        assert!(!match_is_decided(&scored(
            Some("competitive"),
            Some(13),
            None
        )));
    }

    #[test]
    fn presence_menus_ends_a_match_without_waiting_for_three_misses() {
        let mut tracker = LifecycleTracker::default();
        assert_eq!(
            tracker.observe(connected_in_state(Some("match-a"), "INGAME")),
            vec![LifecycleTransition::MatchStarted {
                match_id: "match-a".into()
            }]
        );
        // The game says it is back in the menus, so one observation is enough.
        assert_eq!(
            tracker.observe(connected_in_state(None, "MENUS")),
            vec![LifecycleTransition::MatchEnded {
                match_id: "match-a".into()
            }]
        );
        assert_eq!(
            tracker.observe(connected_in_state(None, "MENUS")),
            Vec::new()
        );
    }

    #[test]
    fn presence_still_in_a_match_does_not_end_it_early() {
        let mut tracker = LifecycleTracker::default();
        tracker.observe(connected_in_state(Some("match-a"), "INGAME"));
        // core-game dropping the match while presence still says INGAME is the
        // blip the miss counter exists for, so the count runs its course.
        assert_eq!(
            tracker.observe(connected_in_state(None, "INGAME")),
            Vec::new()
        );
        assert_eq!(
            tracker.observe(connected_in_state(None, "INGAME")),
            Vec::new()
        );
        assert_eq!(
            tracker.observe(connected_in_state(None, "INGAME")),
            vec![LifecycleTransition::MatchEnded {
                match_id: "match-a".into()
            }]
        );
    }

    #[test]
    fn an_unknown_presence_state_is_not_read_as_out_of_a_match() {
        // A value Riot adds later must not read as "match over"; it falls back
        // to the miss counter like no presence at all.
        let mut tracker = LifecycleTracker::default();
        tracker.observe(connected_in_state(Some("match-a"), "INGAME"));
        assert_eq!(
            tracker.observe(connected_in_state(None, "SOMETHING_NEW")),
            Vec::new()
        );
        assert!(!says_out_of_match(Some("SOMETHING_NEW")));
        assert!(!says_out_of_match(None));
        assert!(says_out_of_match(Some(" menus ")));
    }

    #[test]
    fn first_and_new_pregames_emit_once() {
        let mut tracker = LifecycleTracker::default();
        assert_eq!(
            tracker.observe(connected(Some("pregame-a-blue@ares-pregame.ap"), None)),
            vec![LifecycleTransition::PregameStarted {
                pregame_id: "pregame-a".into(),
            }]
        );
        assert!(tracker
            .observe(connected(Some("pregame-a-red@ares-pregame.ap"), None))
            .is_empty());
        assert_eq!(
            tracker.observe(connected(Some("pregame-b-all@ares-pregame.ap"), None)),
            vec![LifecycleTransition::PregameStarted {
                pregame_id: "pregame-b".into(),
            }]
        );
    }

    #[test]
    fn first_and_repeated_coregame_emit_one_match_start() {
        let mut tracker = LifecycleTracker::default();
        assert_eq!(
            tracker.observe(connected(None, Some("match-a-blue@ares-coregame.ap"))),
            vec![LifecycleTransition::MatchStarted {
                match_id: "match-a".into(),
            }]
        );
        assert!(tracker
            .observe(connected(None, Some("match-a-all@ares-coregame.ap")))
            .is_empty());
    }

    #[test]
    fn match_end_requires_three_consecutive_connected_misses() {
        let mut tracker = LifecycleTracker::default();
        tracker.observe(connected(None, Some("match-a-blue@ares-coregame.ap")));
        assert!(tracker.observe(connected(None, None)).is_empty());
        assert!(tracker.observe(connected(None, None)).is_empty());
        assert_eq!(
            tracker.observe(connected(None, None)),
            vec![LifecycleTransition::MatchEnded {
                match_id: "match-a".into(),
            }]
        );
        assert!(tracker.observe(connected(None, None)).is_empty());
    }

    #[test]
    fn disconnected_polls_retain_state_and_do_not_advance_match_end() {
        let mut tracker = LifecycleTracker::default();
        tracker.observe(connected(Some("pregame-a"), Some("match-a")));
        for _ in 0..4 {
            assert!(tracker.observe(PhaseObservation::default()).is_empty());
        }
        assert!(tracker
            .observe(connected(Some("pregame-a"), Some("match-a")))
            .is_empty());
        assert!(tracker.observe(connected(None, None)).is_empty());
        assert!(tracker.observe(connected(None, None)).is_empty());
        assert_eq!(
            tracker.observe(connected(None, None)),
            vec![LifecycleTransition::MatchEnded {
                match_id: "match-a".into(),
            }]
        );
    }

    #[test]
    fn match_reappearance_before_third_miss_resets_the_counter() {
        let mut tracker = LifecycleTracker::default();
        tracker.observe(connected(None, Some("match-a")));
        tracker.observe(connected(None, None));
        tracker.observe(connected(None, None));
        assert!(tracker.observe(connected(None, Some("match-a"))).is_empty());
        assert!(tracker.observe(connected(None, None)).is_empty());
        assert!(tracker.observe(connected(None, None)).is_empty());
        assert_eq!(
            tracker.observe(connected(None, None)),
            vec![LifecycleTransition::MatchEnded {
                match_id: "match-a".into(),
            }]
        );
    }

    #[test]
    fn direct_match_replacement_ends_old_before_starting_new() {
        let mut tracker = LifecycleTracker::default();
        tracker.observe(connected(None, Some("match-a-blue@ares-coregame.ap")));
        assert_eq!(
            tracker.observe(connected(None, Some("match-b-red@ares-coregame.ap"))),
            vec![
                LifecycleTransition::MatchEnded {
                    match_id: "match-a".into(),
                },
                LifecycleTransition::MatchStarted {
                    match_id: "match-b".into(),
                },
            ]
        );
    }

    #[test]
    fn coregame_color_suffixes_normalize_to_one_match_id() {
        let mut tracker = LifecycleTracker::default();
        assert_eq!(
            tracker.observe(connected(None, Some("same-blue@ares-coregame.ap1.pvp.net"))),
            vec![LifecycleTransition::MatchStarted {
                match_id: "same".into(),
            }]
        );
        assert!(tracker
            .observe(connected(None, Some("same-red@ares-coregame.ap1.pvp.net")))
            .is_empty());
        assert!(tracker
            .observe(connected(None, Some("same-all@ares-coregame.ap1.pvp.net")))
            .is_empty());
    }
}
