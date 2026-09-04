"""
Injects data/dashboard_data.json and data/thesis.json into site/dashboard_template.html,
producing site/dashboard_build.html - the file that gets published as the Artifact.

Run after fetch_and_compute.py (prices) and/or after the thesis paragraphs are
updated, then republish the Artifact with the resulting file.
"""
import json
import os
import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
SITE_DIR = os.path.join(BASE_DIR, "site")


def main():
    with open(os.path.join(DATA_DIR, "etf_data.json"), encoding="utf-8") as f:
        dashboard_data = f.read()
    with open(os.path.join(DATA_DIR, "thesis.json"), encoding="utf-8") as f:
        thesis_data = f.read()
    with open(os.path.join(SITE_DIR, "dashboard_template.html"), encoding="utf-8") as f:
        template = f.read()

    build_meta = json.dumps({
        "built_at_utc": datetime.datetime.utcnow().isoformat() + "Z",
    })

    out = template.replace("__DASHBOARD_DATA_JSON__", dashboard_data)
    out = out.replace("__THESIS_JSON__", thesis_data)
    out = out.replace("__BUILD_META_JSON__", build_meta)

    out_path = os.path.join(SITE_DIR, "dashboard_build.html")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(out)
    print("wrote", out_path, len(out), "bytes")


if __name__ == "__main__":
    main()
