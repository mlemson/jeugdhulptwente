#!/usr/bin/env python3
"""Lokale webserver en veilige bronproxy voor Wachtlijsten Zorgaanbieders Twente."""
from __future__ import annotations

import io
import json
import mimetypes
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    from bs4 import BeautifulSoup
except Exception:
    BeautifulSoup = None

try:
    from pypdf import PdfReader
except Exception:
    PdfReader = None

HOST = "127.0.0.1"
PORT = 8765
START_PAGE = "wachtlijsten_zorgaanbieders_twente_v19.html"
MAX_BYTES = 12 * 1024 * 1024
CACHE_SECONDS = 10 * 60
CACHE: dict[str, tuple[float, dict[str, Any]]] = {}

ALLOWED_HOSTS = {
    "doppazorg.nl", "www.doppazorg.nl", "youz.nl", "www.youz.nl",
    "boncura.nl", "www.boncura.nl", "accare.nl", "www.accare.nl",
    "zmtwente.nl", "www.zmtwente.nl", "kidsclinic.nl", "www.kidsclinic.nl",
    "karakter.com", "www.karakter.com", "samen14.nl", "www.samen14.nl",
    "mediant.nl", "www.mediant.nl", "jarabee.nl", "www.jarabee.nl",
    "ambiq.nl", "www.ambiq.nl", "aveleijn.nl", "www.aveleijn.nl",
    "ribwoverijssel.nl", "www.ribwoverijssel.nl", "tactus.nl", "www.tactus.nl",
    "vdstam.nl", "www.vdstam.nl", "ppeb.nl", "www.ppeb.nl",
    "at-zorg.nl", "www.at-zorg.nl", "hkzorg.nl", "www.hkzorg.nl",
    "hk-zorg.nl", "www.hk-zorg.nl", "praktijkdepoel.nl", "www.praktijkdepoel.nl",
    "desynergie.nl", "www.desynergie.nl", "hsk.nl", "www.hsk.nl",
    "inzichttwente.nl", "www.inzichttwente.nl", "curess.nl", "www.curess.nl",
    "praktijkdenktank.nl", "www.praktijkdenktank.nl",
    "jeugdpraktijkijsselgroep.nl", "www.jeugdpraktijkijsselgroep.nl",
    "dyslexiecentrumtwente.nl", "www.dyslexiecentrumtwente.nl",
    "instituutnijenkamp.nl", "www.instituutnijenkamp.nl",
    "pienterenco.nl", "www.pienterenco.nl", "jeugdx.nl", "www.jeugdx.nl",
    "senzor.nl", "www.senzor.nl", "pmte.nl", "www.pmte.nl",
    "tzeggelt.nl", "www.tzeggelt.nl", "cuidate.nl", "www.cuidate.nl",
    "mentalscope.nl", "www.mentalscope.nl", "pluryn.nl", "www.pluryn.nl",
    "praktijkforza.info", "www.praktijkforza.info", "reggedok.nl", "www.reggedok.nl",
    "tuoro.nl", "www.tuoro.nl", "helderzorg.nl", "www.helderzorg.nl",
    "hethuisvandestraat.nl", "www.hethuisvandestraat.nl",
    "pactum.org", "www.pactum.org", "timon.nl", "www.timon.nl",
}


def normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\t\u00a0 ]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_html(content: bytes, final_url: str, charset: str | None) -> tuple[str, list[str], str]:
    decoded = content.decode(charset or "utf-8", errors="replace")
    links: list[str] = []
    title = ""
    if BeautifulSoup is None:
        title_match = re.search(r"<title[^>]*>(.*?)</title>", decoded, re.I | re.S)
        if title_match:
            title = re.sub(r"<[^>]+>", " ", title_match.group(1)).strip()
        for href in re.findall(r'href=["\']([^"\']+)', decoded, re.I):
            absolute = urllib.parse.urljoin(final_url, href)
            if absolute.startswith(("http://", "https://")):
                links.append(absolute)
        decoded = re.sub(r"<(script|style|noscript)[^>]*>.*?</\1>", " ", decoded, flags=re.I | re.S)
        decoded = re.sub(r"</(p|div|li|tr|h[1-6]|section|article|br)>", "\n", decoded, flags=re.I)
        text = re.sub(r"<[^>]+>", " ", decoded)
        return normalize_text(text), list(dict.fromkeys(links)), title

    soup = BeautifulSoup(decoded, "lxml")
    if soup.title:
        title = soup.title.get_text(" ", strip=True)
    for tag in soup(["script", "style", "noscript", "svg", "canvas"]):
        tag.decompose()
    for a in soup.find_all("a", href=True):
        absolute = urllib.parse.urljoin(final_url, a.get("href"))
        if absolute.startswith(("http://", "https://")):
            links.append(absolute)
    table_lines: list[str] = []
    for tr in soup.find_all("tr"):
        cells = [c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])]
        if cells:
            table_lines.append("\t".join(cells))
    body_text = soup.get_text("\n", strip=True)
    text = "\n".join(table_lines + [body_text])
    return normalize_text(text), list(dict.fromkeys(links)), title


def extract_pdf(content: bytes) -> str:
    if PdfReader is None:
        raise RuntimeError("PDF-uitlezing is niet beschikbaar: pypdf ontbreekt.")
    reader = PdfReader(io.BytesIO(content))
    return normalize_text("\n".join((page.extract_text() or "") for page in reader.pages))


def fetch_url(url: str) -> dict[str, Any]:
    now = time.time()
    cached = CACHE.get(url)
    if cached and now - cached[0] < CACHE_SECONDS:
        result = dict(cached[1])
        result["cached"] = True
        return result

    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Alleen http- en https-bronnen zijn toegestaan.")
    if parsed.hostname not in ALLOWED_HOSTS:
        raise ValueError(f"Bronhost is niet toegestaan: {parsed.hostname}")

    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 WachtlijstenTwente/19",
            "Accept": "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.7",
            "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.5",
            "Accept-Encoding": "identity",
            "Cache-Control": "no-cache",
        },
    )
    with urllib.request.urlopen(request, timeout=25) as response:
        final_url = response.geturl()
        content_type = response.headers.get_content_type()
        charset = response.headers.get_content_charset()
        content = response.read(MAX_BYTES + 1)
        if len(content) > MAX_BYTES:
            raise RuntimeError("Bron is groter dan de ingestelde veiligheidslimiet.")

    links: list[str] = []
    title = ""
    if content_type == "application/pdf" or final_url.lower().split("?")[0].endswith(".pdf"):
        text = extract_pdf(content)
        content_type = "application/pdf"
    elif content_type.startswith("text/html") or b"<html" in content[:1000].lower():
        text, links, title = extract_html(content, final_url, charset)
        content_type = "text/html"
    else:
        text = normalize_text(content.decode(charset or "utf-8", errors="replace"))

    result = {
        "ok": True,
        "requested_url": url,
        "final_url": final_url,
        "content_type": content_type,
        "title": title,
        "text": text,
        "links": links,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "cached": False,
    }
    CACHE[url] = (now, result)
    return result


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            self._json(200, {"ok": True, "version": 19})
            return
        if parsed.path == "/api/text":
            query = urllib.parse.parse_qs(parsed.query)
            url = (query.get("url") or [""])[0]
            if not url:
                self._json(400, {"ok": False, "error": "URL ontbreekt."})
                return
            try:
                self._json(200, fetch_url(url))
            except urllib.error.HTTPError as exc:
                self._json(502, {"ok": False, "error": f"Bron gaf HTTP {exc.code}", "url": url})
            except Exception as exc:
                self._json(502, {"ok": False, "error": str(exc), "url": url})
            return
        super().do_GET()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stdout.flush()


def main() -> None:
    os.chdir(Path(__file__).resolve().parent)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/{START_PAGE}"
    print("Wachtlijsten Twente draait lokaal.")
    print(f"Open: {url}")
    print("Sluit dit venster om de lokale server te stoppen.\n")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
