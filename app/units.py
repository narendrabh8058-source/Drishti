"""Which ISRO centre / unit does an item talk about? Used by the feed buttons (URSC, LPSC, ...)."""
import re

# unit -> (acronyms matched case-sensitively, full names matched case-insensitively)
# DOS and MOX are matched by their FULL NAME only: as bare acronyms they clash with other meanings.
UNITS = {
    "URSC": (["URSC"], ["U R Rao Satellite Centre", "UR Rao Satellite Centre", "U.R. Rao Satellite Centre", "U. R. Rao Satellite Centre"]),
    "ISITE": (["ISITE"], ["Satellite Integration and Test Establishment"]),
    "IDSN": (["IDSN"], ["Indian Deep Space Network"]),
    "LPSC": (["LPSC"], ["Liquid Propulsion Systems Centre"]),
    "LEOS": (["LEOS"], ["Laboratory for Electro-Optics Systems", "Laboratory for Electro Optics Systems"]),
    "ISTRAC": (["ISTRAC"], ["ISRO Telemetry, Tracking and Command Network", "Telemetry, Tracking and Command Network",
                            "ISRO Telemetry Tracking and Command Network"]),
    "DOS": ([], ["Department of Space", "अंतरिक्ष विभाग"]),
    "MOX": ([], ["Mission Operations Complex"]),
}
UNIT_NAMES = list(UNITS)

_ACR = {u: [re.compile(r"\b" + re.escape(a) + r"\b") for a in acr] for u, (acr, _) in UNITS.items()}
_NAME = {u: [re.compile(r"\s+".join(map(re.escape, n.split())), re.I) for n in names] for u, (_, names) in UNITS.items()}


def detect_units(title):
    """',URSC,LPSC,' style string (so a LIKE '%,URSC,%' finds it), or '' when no unit is named."""
    found = [u for u in UNIT_NAMES if any(r.search(title or "") for r in _ACR[u]) or any(r.search(title or "") for r in _NAME[u])]
    return "," + ",".join(found) + "," if found else ""


def fill_units(conn):
    rows = conn.execute("SELECT id, title FROM mentions WHERE unit IS NULL").fetchall()
    if rows:
        conn.executemany("UPDATE mentions SET unit=? WHERE id=?", [(detect_units(r["title"]), r["id"]) for r in rows])
        conn.commit()
    return len(rows)


def scope_clause(scope):
    """'CISF,URSC,LPSC,SPACE' -> (' AND (topic=? OR unit LIKE ? OR ...)', args). Choosing several means ANY of them. Nothing chosen = no filter."""
    parts, args = [], []
    for t in [x.strip().upper() for x in (scope or "").split(",") if x.strip()]:
        if t in ("CISF", "ISRO"):
            parts.append("topic=?"); args.append(t)
        elif t == "SPACE":
            parts.append("category='space'")
        elif t in UNIT_NAMES:
            parts.append("unit LIKE ?"); args.append(f"%,{t},%")
    return (" AND (" + " OR ".join(parts) + ")", args) if parts else ("", [])
