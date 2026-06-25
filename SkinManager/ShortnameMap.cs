using System.Collections.Generic;
using System.Text;

namespace SkengSkinManager
{
    // The server's item catalog, mirrored from BYAplugin.cs:
    //   weapons  -> BYAWeaponDefs
    //   clothing -> BYA_ARMOR_REGISTRY
    // It does two jobs:
    //   1. Suggest()  — map a Workshop skin's item tag to the Rust shortname
    //                   (/skincreate + the skin reward both need the shortname).
    //   2. the catalog import filter — a skin whose tag resolves to nothing here
    //      is "not one we use" and gets silently dropped on import.
    // Matching is normalized (lowercase, alphanumerics only) so "SPAS-12",
    // "spas 12" and "spas12" all match. Shortnames are the SERVER's exact
    // shortnames so they stay consistent with the plugin. Extend CATALOG +
    // rebuild to add items.
    public static class ShortnameMap
    {
        // (shortname, Workshop item-name aliases). The shortname itself is also
        // added as an alias automatically.
        private static readonly (string sn, string[] names)[] CATALOG = new (string, string[])[]
        {
            // ── Weapons (BYAWeaponDefs) ──────────────────────────────────
            ("spear.wooden",          new[]{ "Wooden Spear" }),
            ("spear.stone",           new[]{ "Stone Spear" }),
            ("boomerang",             new[]{ "Boomerang" }),
            ("bow.hunting",           new[]{ "Hunting Bow" }),
            ("pistol.eoka",           new[]{ "Eoka Pistol", "Eoka" }),
            ("salvaged.sword",        new[]{ "Salvaged Sword" }),
            ("blowpipe",              new[]{ "Blow Pipe", "Blowpipe" }),
            ("grenade.f1",            new[]{ "F1 Grenade" }),
            ("crossbow",              new[]{ "Crossbow" }),
            ("minicrossbow",          new[]{ "Mini Crossbow" }),
            ("bow.compound",          new[]{ "Compound Bow" }),
            ("pistol.nailgun",        new[]{ "Nailgun", "Nail Gun" }),
            ("shotgun.waterpipe",     new[]{ "Waterpipe Shotgun" }),
            ("shotgun.double",        new[]{ "Double Barrel Shotgun" }),
            ("t1_smg",                new[]{ "Handmade SMG" }),
            ("pistol.revolver",       new[]{ "Revolver" }),
            ("speargun",              new[]{ "Speargun" }),
            ("pistol.semiauto",       new[]{ "Semi-Automatic Pistol", "Semi Automatic Pistol" }),
            ("pistol.python",         new[]{ "Python Revolver", "Python" }),
            ("smg.thompson",          new[]{ "Thompson" }),
            ("smg.2",                 new[]{ "Custom SMG" }),
            ("rifle.semiauto",        new[]{ "Semi-Automatic Rifle", "Semi Automatic Rifle" }),
            ("shotgun.pump",          new[]{ "Pump Shotgun" }),
            ("pistol.m92",            new[]{ "M92 Pistol", "M92" }),
            ("pistol.prototype17",    new[]{ "Prototype 17" }),
            ("revolver.hc",           new[]{ "Heavy-Cal Revolver" }),
            ("flamethrower",          new[]{ "Flame Thrower", "Flamethrower" }),
            ("snowballgun",           new[]{ "Snowball Gun" }),
            ("rifle.ak",              new[]{ "Assault Rifle", "AK47", "AK-47" }),
            ("rifle.lr300",           new[]{ "LR300", "LR-300" }),
            ("m16a2",                 new[]{ "M16A2", "M16" }),
            ("smg.mp5",               new[]{ "MP5A4", "MP5" }),
            ("rifle.sks",             new[]{ "SKS" }),
            ("rifle.bolt",            new[]{ "Bolt Action Rifle" }),
            ("rifle.l96",             new[]{ "L96", "L96 Rifle" }),
            ("lmg.m249",              new[]{ "M249" }),
            ("hmlmg",                 new[]{ "HMLMG" }),
            ("shotgun.spas12",        new[]{ "SPAS-12", "Spas12" }),
            ("shotgun.m4",            new[]{ "M4 Shotgun" }),
            ("rocket.launcher",       new[]{ "Rocket Launcher" }),
            ("rifle.m39",             new[]{ "M39", "M39 Rifle" }),
            ("minigun",               new[]{ "Minigun" }),
            ("multiplegrenadelauncher", new[]{ "Multiple Grenade Launcher", "MGL" }),
            ("mortar.deployable",     new[]{ "Mortar" }),
            ("militaryflamethrower",  new[]{ "Military Flamethrower" }),

            // ── Clothing / armor (BYA_ARMOR_REGISTRY) ────────────────────
            ("ballistic.helmet",      new[]{ "Ballistic Helmet" }),
            ("metal.facemask",        new[]{ "Metal Facemask", "Metal Face Mask" }),
            ("coffeecan.helmet",      new[]{ "Coffee Can Helmet" }),
            ("wood.armor.helmet",     new[]{ "Wood Armor Helmet", "Wood Helmet" }),
            ("knightsarmour.helmet",  new[]{ "Knight Helmet", "Knights Helmet" }),
            ("hat.wolf",              new[]{ "Wolf Headdress" }),
            ("bucket.helmet",         new[]{ "Bucket Helmet" }),
            ("deer.skull.mask",       new[]{ "Deer Skull Mask" }),
            ("nightvisiongoggles",    new[]{ "Night Vision Goggles", "NVG" }),
            ("ballistic.vest",        new[]{ "Ballistic Vest" }),
            ("metal.plate.torso",     new[]{ "Metal Chest Plate", "Metal Chestplate" }),
            ("roadsign.jacket",       new[]{ "Road Sign Jacket", "Roadsign Vest", "Road Sign Vest" }),
            ("jacket",                new[]{ "Jacket" }),
            ("wood.armor.jacket",     new[]{ "Wood Chestplate", "Wood Armor Jacket" }),
            ("attire.hide.poncho",    new[]{ "Hide Poncho" }),
            ("jacket.snow",           new[]{ "Snow Jacket" }),
            ("draculacape",           new[]{ "Dracula Cape" }),
            ("knighttorso.armour",    new[]{ "Knight Plate Armor", "Knight Armor" }),
            ("hoodie",                new[]{ "Hoodie" }),
            ("tshirt",                new[]{ "T-Shirt", "Tshirt" }),
            ("burlap.shirt",          new[]{ "Burlap Shirt" }),
            ("tanktop",               new[]{ "Tank Top" }),
            ("attire.hide.helterneck",new[]{ "Hide Halterneck" }),
            ("tactical.gloves",       new[]{ "Tactical Gloves" }),
            ("roadsign.gloves",       new[]{ "Road Sign Gloves", "Roadsign Gloves" }),
            ("burlap.gloves",         new[]{ "Leather Gloves" }),
            ("woodarmor.gloves",      new[]{ "Wood Armor Gloves" }),
            ("burlap.gloves.new",     new[]{ "Burlap Gloves" }),
            ("ballistic.legarmor",    new[]{ "Ballistic Leg Armor" }),
            ("roadsign.kilt",         new[]{ "Road Sign Kilt", "Roadsign Kilt" }),
            ("knightsarmour.skirt",   new[]{ "Knight Skirt" }),
            ("wood.armor.pants",      new[]{ "Wood Armor Pants" }),
            ("chicken.costume",       new[]{ "Chicken Costume" }),
            ("horse.costume",         new[]{ "Horse Costume" }),
            ("pants",                 new[]{ "Pants" }),
            ("burlap.trousers",       new[]{ "Burlap Trousers" }),
            ("pants.shorts",          new[]{ "Shorts" }),
            ("attire.hide.pants",     new[]{ "Hide Pants" }),
            ("attire.hide.skirt",     new[]{ "Hide Skirt" }),
            ("shoes.boots",           new[]{ "Boots" }),
            ("attire.hide.boots",     new[]{ "Hide Boots" }),
            ("boots.frog",            new[]{ "Frog Boots" }),
            ("burlap.shoes",          new[]{ "Burlap Shoes" }),
            ("hazmatsuit",            new[]{ "Hazmat Suit" }),
            ("hazmatsuit.nomadsuit",  new[]{ "Nomad Suit" }),
            ("hazmatsuit.lumberjack", new[]{ "Lumberjack Suit" }),
            ("hazmatsuit.arcticsuit", new[]{ "Arctic Suit" }),
            ("ninjasuit",             new[]{ "Ninja Suit" }),
            ("attire.egg.suit",       new[]{ "Egg Suit" }),
        };

        private static readonly Dictionary<string, string> _byNorm = Build();

        private static Dictionary<string, string> Build()
        {
            var d = new Dictionary<string, string>();
            foreach (var (sn, names) in CATALOG)
            {
                var ks = Norm(sn);
                if (ks.Length > 0 && !d.ContainsKey(ks)) d[ks] = sn;
                foreach (var n in names)
                {
                    var k = Norm(n);
                    if (k.Length > 0 && !d.ContainsKey(k)) d[k] = sn;
                }
            }
            return d;
        }

        private static string Norm(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder(s.Length);
            foreach (var ch in s)
                if (char.IsLetterOrDigit(ch)) sb.Append(char.ToLowerInvariant(ch));
            return sb.ToString();
        }

        // Returns the catalog shortname for the first recognised tag, or "".
        public static string Suggest(IEnumerable<string> tags)
        {
            if (tags == null) return "";
            foreach (var t in tags)
                if (_byNorm.TryGetValue(Norm(t), out var sn)) return sn;
            return "";
        }

        // True when the skin maps to a catalog item (drives the import filter).
        public static bool IsCatalogItem(IEnumerable<string> tags) => Suggest(tags).Length > 0;
    }
}
