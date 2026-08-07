/// XMPP chat server region table — mirrors @windowsedd/valorant-api's
/// `XmppRegions` enum-like static object. `affinity` is the chat server
/// subdomain (`<affinity>.chat.si.riotgames.com`), `domain` is used in the
/// stream `to` attribute, `lookup_name` matches the PAS JWT's `affinity` claim.
pub struct XmppRegion {
    pub affinity: &'static str,
    pub domain: &'static str,
    pub lookup_name: &'static str,
}

const REGIONS: &[XmppRegion] = &[
    XmppRegion { affinity: "jp1", domain: "jp1", lookup_name: "asia" },
    XmppRegion { affinity: "as2", domain: "as2", lookup_name: "as2" },
    XmppRegion { affinity: "br", domain: "br1", lookup_name: "br1" },
    XmppRegion { affinity: "ru1", domain: "ru1", lookup_name: "eu" },
    XmppRegion { affinity: "eu3", domain: "eu3", lookup_name: "eu3" },
    XmppRegion { affinity: "eun1", domain: "eu2", lookup_name: "eun1" },
    XmppRegion { affinity: "euw1", domain: "eu1", lookup_name: "euw1" },
    XmppRegion { affinity: "jp1", domain: "jp1", lookup_name: "jp1" },
    XmppRegion { affinity: "la1", domain: "la1", lookup_name: "la1" },
    XmppRegion { affinity: "la2", domain: "la2", lookup_name: "la2" },
    XmppRegion { affinity: "na2", domain: "na1", lookup_name: "na1" },
    XmppRegion { affinity: "la1", domain: "la1", lookup_name: "us" },
    XmppRegion { affinity: "br", domain: "br1", lookup_name: "us-br1" },
    XmppRegion { affinity: "la2", domain: "la2", lookup_name: "us-la2" },
    XmppRegion { affinity: "us2", domain: "us2", lookup_name: "us2" },
    XmppRegion { affinity: "oc1", domain: "oc1", lookup_name: "oc1" },
    XmppRegion { affinity: "pbe1", domain: "pb1", lookup_name: "pbe1" },
    XmppRegion { affinity: "ru1", domain: "ru1", lookup_name: "ru1" },
    XmppRegion { affinity: "sa1", domain: "sa1", lookup_name: "sea1" },
    XmppRegion { affinity: "sa2", domain: "sa2", lookup_name: "sea2" },
    XmppRegion { affinity: "sa3", domain: "sa3", lookup_name: "sea3" },
    XmppRegion { affinity: "sa4", domain: "sa4", lookup_name: "sea4" },
    XmppRegion { affinity: "kr1", domain: "kr1", lookup_name: "kr1" },
    XmppRegion { affinity: "tr1", domain: "tr1", lookup_name: "tr1" },
];

pub fn region_by_lookup_name(name: &str) -> Option<&'static XmppRegion> {
    REGIONS.iter().find(|r| r.lookup_name == name)
}
