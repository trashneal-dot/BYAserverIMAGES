using System.Collections.Generic;

namespace SkengSkinManager
{
    // Best-effort Workshop-tag -> Rust item shortname. Rust skins are tagged
    // with the item's display-ish name (e.g. "AK47"); /skincreate and the skin
    // reward both need the shortname (e.g. "rifle.ak"). We auto-suggest from the
    // first tag we recognise; the user confirms/overrides per skin in the UI.
    // Keys are lowercased. Extend freely — unmatched skins just need a manual
    // shortname.
    public static class ShortnameMap
    {
        private static readonly Dictionary<string, string> Map = new Dictionary<string, string>
        {
            // ── Rifles / LMG ─────────────────────────────────────────────
            { "ak47", "rifle.ak" }, { "assault rifle", "rifle.ak" },
            { "lr-300", "rifle.lr300" }, { "lr300", "rifle.lr300" },
            { "m39", "rifle.m39" }, { "m39 rifle", "rifle.m39" },
            { "semi-automatic rifle", "rifle.semiauto" }, { "sar", "rifle.semiauto" },
            { "bolt action rifle", "rifle.bolt" }, { "bolt rifle", "rifle.bolt" },
            { "l96", "rifle.l96" }, { "l96 rifle", "rifle.l96" },
            { "m249", "lmg.m249" },
            // ── SMG ──────────────────────────────────────────────────────
            { "mp5", "smg.mp5" }, { "mp5a4", "smg.mp5" },
            { "custom smg", "smg.2" }, { "thompson", "smg.thompson" },
            // ── Pistols ──────────────────────────────────────────────────
            { "semi-automatic pistol", "pistol.semiauto" },
            { "python", "pistol.python" }, { "python revolver", "pistol.python" },
            { "revolver", "pistol.revolver" },
            { "m92", "pistol.m92" }, { "m92 pistol", "pistol.m92" },
            { "p250", "pistol.p250" }, { "sp1", "pistol.semiauto" },
            { "eoka", "pistol.eoka" }, { "eoka pistol", "pistol.eoka" },
            { "nailgun", "pistol.nailgun" }, { "nail gun", "pistol.nailgun" },
            // ── Shotguns ─────────────────────────────────────────────────
            { "spas-12", "shotgun.spas12" }, { "spas12", "shotgun.spas12" },
            { "pump shotgun", "shotgun.pump" },
            { "double barrel shotgun", "shotgun.double" },
            { "waterpipe shotgun", "shotgun.waterpipe" },
            // ── Bows / explosives / heavy ────────────────────────────────
            { "crossbow", "crossbow" },
            { "compound bow", "bow.compound" }, { "hunting bow", "bow.hunting" },
            { "rocket launcher", "rocket.launcher" },
            { "multiple grenade launcher", "multiplegrenadelauncher" },
            { "f1 grenade", "grenade.f1" }, { "satchel charge", "explosive.satchel" },
            // ── Melee / tools ────────────────────────────────────────────
            { "machete", "machete" }, { "combat knife", "knife.combat" },
            { "salvaged sword", "salvaged.sword" }, { "salvaged cleaver", "salvaged.cleaver" },
            { "hatchet", "hatchet" }, { "pickaxe", "pickaxe" },
            { "salvaged axe", "axe.salvaged" }, { "salvaged icepick", "icepick.salvaged" },
            { "stone hatchet", "stonehatchet" }, { "stone pickaxe", "stone.pickaxe" },
            { "rock", "rock" }, { "jackhammer", "jackhammer" }, { "chainsaw", "chainsaw" },
            { "torch", "torch" }, { "longsword", "longsword" }, { "mace", "mace" },
            // ── Wearables (common) ───────────────────────────────────────
            { "hoodie", "hoodie" }, { "pants", "pants" },
            { "t-shirt", "tshirt" }, { "tshirt", "tshirt" }, { "long t-shirt", "tshirt.long" },
            { "tank top", "tshirt.tanktop" }, { "shorts", "shorts" }, { "longsleeve t-shirt", "tshirt.long" },
            { "boonie hat", "hat.boonie" }, { "beenie hat", "hat.beenie" },
            { "bucket helmet", "bucket.helmet" }, { "coffee can helmet", "coffeecan.helmet" },
            { "metal facemask", "metal.facemask" }, { "metal chest plate", "metal.plate.torso" },
            { "road sign jacket", "roadsign.jacket" }, { "road sign kilt", "roadsign.kilt" },
            { "burlap shirt", "burlap.shirt" }, { "burlap trousers", "burlap.trousers" },
            { "burlap headwrap", "burlap.headwrap" }, { "burlap shoes", "burlap.shoes" },
            { "balaclava", "mask.balaclava" }, { "bandana mask", "mask.bandana" },
            { "snow jacket", "jacket.snow" }, { "work boots", "shoes.boots" },
            { "riot helmet", "riot.helmet" }, { "wetsuit", "diving.wetsuit" },
            { "hide poncho", "attire.hide.poncho" }, { "leather gloves", "burlap.gloves" },
            // ── Deployables (common) ─────────────────────────────────────
            { "sleeping bag", "sleepingbag" },
            { "large wood box", "box.wooden.large" }, { "wood storage box", "box.wooden" },
            { "furnace", "furnace" }, { "sheet metal door", "door.hinged.metal" },
            { "armored door", "door.hinged.toptier" }, { "wooden door", "door.hinged.wood" },
            { "garage door", "wall.frame.garagedoor" }, { "tool cupboard", "cupboard.tool" },
            { "vending machine", "vending.machine" }, { "locker", "locker" },
            { "reactive target", "target.reactive" }, { "fridge", "fridge" },
            { "large furnace", "furnace.large" }, { "rug", "rug" },
        };

        // Returns a shortname suggestion from the first recognised tag, or "".
        public static string Suggest(IEnumerable<string> tags)
        {
            if (tags == null) return "";
            foreach (var t in tags)
            {
                if (string.IsNullOrEmpty(t)) continue;
                if (Map.TryGetValue(t.Trim().ToLowerInvariant(), out var sn)) return sn;
            }
            return "";
        }
    }
}
