const MATCH_END_CONNECTED_MISSES: u8 = 3;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PhaseObservation {
    pub connected: bool,
    pub pregame_id: Option<String>,
    pub match_id: Option<String>,
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
            (Some(_), Some(_)) => {
                self.connected_match_misses = 0;
            }
            (Some(active), None) => {
                self.connected_match_misses = self.connected_match_misses.saturating_add(1);
                if self.connected_match_misses == MATCH_END_CONNECTED_MISSES {
                    transitions.push(LifecycleTransition::MatchEnded { match_id: active });
                    self.active_match_id = None;
                    self.connected_match_misses = 0;
                }
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
        }
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
