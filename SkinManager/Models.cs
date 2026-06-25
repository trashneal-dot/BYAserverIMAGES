using System.Collections.Generic;
using Newtonsoft.Json;

namespace SkengSkinManager
{
    // ─────────────────────────────────────────────────────────────────────
    // Mirror of the plugin's mission models (BYAplugin.cs). Field names &
    // shape MUST match so a def we build here deserializes 1:1 on the server
    // via `bya.admin missions import <base64>`. Newtonsoft matches property
    // names case-insensitively, but we keep PascalCase to mirror the source.
    // NullValueHandling.Ignore keeps the emitted JSON minimal (smaller base64).
    // ─────────────────────────────────────────────────────────────────────

    public class MissionDef
    {
        public string Key;
        public string Title;
        public string Description;

        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public string PictureUrl;
        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public int IconItemId;
        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public ulong IconSkinId;

        public string Type = "standard";   // standard | daily | weekly | secondary | attachment

        public List<MissionTrackerSpec> Trackers = new List<MissionTrackerSpec>();
        public List<MissionReward> Rewards = new List<MissionReward>();

        // The server owns the reconcile version; it bumps on import. We omit it
        // so we never fight that logic.
        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public MissionEligibility Eligibility;
    }

    public class MissionTrackerSpec
    {
        public string Key;          // tracker grammar string, e.g. "kill_class:smg@t2"
        public int Threshold = 1;

        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public List<string> Missions;  // only for the "mission"/"complete:<cat>" trackers
    }

    public class MissionReward
    {
        public string Type;                 // attachment | skin | secondary | xp | skinset
        public string Target;               // shortname / workshop id / number-as-string

        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public string WeaponContext;
        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public string TierContext;
        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public string ItemShortname;        // for Type == "skin": item the skin applies to
        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public Dictionary<string, ulong> SkinSetEntries;
    }

    public class MissionEligibility
    {
        public int MinLevel;
        public string MinPrestige;
        public string RequiresPerm;
    }

    // The on-disk catalog shape (oxide/data/bya/missions.json) — we only read it.
    public class MissionCatalog
    {
        public Dictionary<string, MissionDef> Missions = new Dictionary<string, MissionDef>();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Local app library (owned by this tool; stored under %AppData%).
    // ─────────────────────────────────────────────────────────────────────

    public class Library
    {
        public List<SkinGroup> groups = new List<SkinGroup>();
        public List<SkinEntry> skins = new List<SkinEntry>();
    }

    public class SkinGroup
    {
        public string id;
        public string name;
        public string color = "#c9a54c";
        public string note;
    }

    public class SkinEntry
    {
        public string id;            // workshop published file id (string)
        public string groupId;
        public string title;
        public string shortname;     // item the skin applies to (user-confirmable)
        public bool shortnameAuto;   // true => auto-suggested, not yet confirmed
        public List<string> tags = new List<string>();
        public string previewUrl;
        public bool cached;          // image present at cache.skin/<id>.jpg
        public bool banned;          // workshop item banned/removed
        public bool used;            // manually marked "used in a mission" (reserved)
        public string addedAt;
    }
}
