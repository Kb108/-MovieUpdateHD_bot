import os
import re
import time
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests
from pyrogram import Client
from pyrogram.errors import FloodWait, RPCError


# =========================================================
# ENVIRONMENT VARIABLES
# =========================================================

API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]
SESSION_STRING = os.environ["SESSION_STRING"]

WORKER_URL = os.environ["WORKER_URL"].rstrip("/")
INDEX_SECRET = os.environ["INDEX_SECRET"]

PORT = int(os.environ.get("PORT", "10000"))


# =========================================================
# RENDER HEALTH SERVER
# =========================================================

class HealthHandler(BaseHTTPRequestHandler):

    def do_GET(self):

        if self.path in ["/", "/health", "/healthz"]:

            body = b"Movie Cloud Indexer is running!"

            self.send_response(200)
            self.send_header(
                "Content-Type",
                "text/plain"
            )
            self.send_header(
                "Content-Length",
                str(len(body))
            )
            self.end_headers()

            self.wfile.write(body)

        else:

            body = b"Not Found"

            self.send_response(404)
            self.send_header(
                "Content-Type",
                "text/plain"
            )
            self.send_header(
                "Content-Length",
                str(len(body))
            )
            self.end_headers()

            self.wfile.write(body)

    def log_message(self, format, *args):
        return


def start_health_server():

    server = HTTPServer(
        ("0.0.0.0", PORT),
        HealthHandler
    )

    print(
        f"Health server running on port {PORT}",
        flush=True
    )

    server.serve_forever()


# =========================================================
# TELEGRAM CLIENT
# =========================================================

app = Client(
    "movie_cloud_indexer",
    api_id=API_ID,
    api_hash=API_HASH,
    session_string=SESSION_STRING
)


# =========================================================
# COMMON HEADERS
# =========================================================

HEADERS = {
    "X-Index-Secret": INDEX_SECRET,
    "Content-Type": "application/json",
}


# =========================================================
# GET INDEX JOB
# =========================================================

def get_job():

    try:

        # IMPORTANT:
        # Cloudflare Worker expects secret in query parameter
        url = (
            f"{WORKER_URL}/index-job"
            f"?secret={INDEX_SECRET}"
        )

        response = requests.get(
            url,
            headers=HEADERS,
            timeout=30
        )

        print(
            "Worker job response:",
            response.status_code,
            response.text[:1000],
            flush=True
        )

        if response.status_code != 200:

            print(
                "Worker job request failed:",
                response.status_code,
                response.text[:500],
                flush=True
            )

            return None

        data = response.json()

        if not isinstance(data, dict):
            return None

        job = None

        if isinstance(data.get("job"), dict):
            job = data["job"]

        elif isinstance(data.get("data"), dict):
            job = data["data"]

        elif data.get("id") is not None:
            job = data

        if not job:

            print(
                "No job available.",
                flush=True
            )

            return None

        if job.get("id") is None:

            print(
                "Job found but ID is missing:",
                job,
                flush=True
            )

            return None

        return job

    except Exception as e:

        print(
            "get_job error:",
            e,
            flush=True
        )

        return None


# =========================================================
# COMPLETE / UPDATE JOB
# =========================================================

def complete_job(
    job_id,
    status,
    total_indexed,
    error_message=""
):

    if job_id is None:

        print(
            "ERROR: job_id is missing.",
            flush=True
        )

        return

    payload = {
        "job_id": job_id,
        "status": status,
        "total_indexed": total_indexed,
        "last_message_id": 0,
        "error": error_message
    }

    try:

        # IMPORTANT:
        # Your Worker uses /index-job/update
        url = (
            f"{WORKER_URL}/index-job/update"
            f"?secret={INDEX_SECRET}"
        )

        response = requests.post(
            url,
            headers=HEADERS,
            json=payload,
            timeout=30
        )

        print(
            "Job update response:",
            response.status_code,
            response.text[:1000],
            flush=True
        )

    except Exception as e:

        print(
            "complete_job error:",
            e,
            flush=True
        )


# =========================================================
# SEND MOVIE TO CLOUDFLARE WORKER
# =========================================================

def send_movie(movie):

    try:

        response = requests.post(
            f"{WORKER_URL}/index",
            headers=HEADERS,
            json=movie,
            timeout=30
        )

        if response.status_code == 200:

            return True

        print(
            "Index request failed:",
            response.status_code,
            response.text[:500],
            flush=True
        )

        return False

    except Exception as e:

        print(
            "send_movie error:",
            e,
            flush=True
        )

        return False


# =========================================================
# REGEX PATTERNS
# =========================================================

QUALITY_PATTERN = re.compile(
    r"\b("
    r"2160p|1080p|1080i|720p|576p|480p|360p|"
    r"4K|2K|8K|"
    r"WEB[- ]?DL|WEB[- ]?Rip|WEBRip|"
    r"BluRay|BRRip|BDRip|HDRip|HDTV|DVDRip|CAM|"
    r"HEVC|x265|x264"
    r")\b",
    re.IGNORECASE
)


SIZE_PATTERN = re.compile(
    r"\b\d+(?:\.\d+)?\s*(?:GB|MB|KB)\b",
    re.IGNORECASE
)


LANGUAGE_PATTERN = re.compile(
    r"\b("
    r"English|Hindi|Bengali|Bangla|Tamil|Telugu|Malayalam|"
    r"Kannada|Marathi|Punjabi|Gujarati|Urdu|Odia|Assamese|"
    r"Japanese|Korean|Chinese|Spanish|French|German|"
    r"Dual Audio|Multi Audio|Multi-Audio|"
    r"Hindi Dubbed|Bangla Dubbed|Tamil Dubbed|Telugu Dubbed"
    r")\b",
    re.IGNORECASE
)


# =========================================================
# CLEAN TITLE
# =========================================================

def clean_title(text):

    if not text:
        return ""

    lines = []

    for line in text.splitlines():

        line = line.strip()

        if not line:
            continue

        if re.fullmatch(r"[\W_]+", line):
            continue

        lines.append(line)

    if not lines:
        return ""

    title = lines[0]

    title = re.sub(
        r"^[\s\[\]\(\){}*_~`#•⭐🔥🎬🎥📺📽️]+",
        "",
        title
    )

    title = re.sub(
        r"[\s\[\]\(\){}*_~`#•⭐🔥🎬🎥📺📽️]+$",
        "",
        title
    )

    title = re.sub(
        r"^(movie|film|title)\s*[:\-]\s*",
        "",
        title,
        flags=re.IGNORECASE
    )

    return title.strip()


# =========================================================
# EXTRACT LANGUAGE
# =========================================================

def extract_language(text):

    if not text:
        return ""

    matches = LANGUAGE_PATTERN.findall(text)

    if not matches:
        return ""

    unique = []

    for item in matches:

        item = item.strip()

        if item.lower() not in [
            x.lower() for x in unique
        ]:
            unique.append(item)

    return ", ".join(unique[:4])


# =========================================================
# EXTRACT QUALITY
# =========================================================

def extract_quality(text):

    if not text:
        return ""

    matches = QUALITY_PATTERN.findall(text)

    if not matches:
        return ""

    unique = []

    for item in matches:

        item = item.strip()

        if item.lower() not in [
            x.lower() for x in unique
        ]:
            unique.append(item)

    return ", ".join(unique[:5])


# =========================================================
# EXTRACT SIZE
# =========================================================

def extract_size(text):

    if not text:
        return ""

    matches = SIZE_PATTERN.findall(text)

    if not matches:
        return ""

    return matches[0]


# =========================================================
# GET MESSAGE TEXT
# =========================================================

def get_message_text(message):

    if getattr(message, "text", None):
        return message.text

    if getattr(message, "caption", None):
        return message.caption

    return ""


# =========================================================
# GET FILE NAME
# =========================================================

def get_file_name(message):

    try:

        if (
            message.document
            and message.document.file_name
        ):
            return message.document.file_name

        if (
            message.video
            and message.video.file_name
        ):
            return message.video.file_name

        if (
            message.audio
            and message.audio.file_name
        ):
            return message.audio.file_name

    except Exception:
        pass

    return ""


# =========================================================
# BUILD MOVIE
# =========================================================

def build_movie(
    message,
    channel_id,
    source_username
):

    text = get_message_text(message)

    file_name = get_file_name(message)

    combined_text = text

    if not combined_text and file_name:
        combined_text = file_name

    if not combined_text:
        return None

    title = clean_title(combined_text)

    if not title:
        return None

    lower_title = title.lower()

    ignored_words = [
        "subscribe",
        "join now",
        "advertisement",
        "admin",
        "contact us",
        "follow us",
        "request here",
        "rules"
    ]

    if any(
        word in lower_title
        for word in ignored_words
    ):
        return None

    language = extract_language(
        combined_text
    )

    quality = extract_quality(
        combined_text
    )

    size = extract_size(
        combined_text
    )

    return {
        "title": title,
        "language": language,
        "quality": quality,
        "size": size,
        "poster": "",
        "channel_id": str(channel_id),
        "message_id": int(message.id),
        "source_username": source_username or ""
    }


# =========================================================
# GET SOURCE CHAT
# =========================================================

def get_source_chat(job):

    source_username = (
        job.get("source_username") or ""
    )

    source_channel_id = job.get(
        "source_channel_id"
    )

    if source_username:
        return source_username

    if source_channel_id:

        try:
            return int(source_channel_id)

        except Exception:
            return source_channel_id

    return None


# =========================================================
# PROCESS INDEX JOB
# =========================================================

def process_job(job):

    job_id = job.get("id")

    source_channel_id = job.get(
        "source_channel_id"
    )

    source_username = (
        job.get("source_username") or ""
    )

    print("")
    print("=" * 60)
    print("NEW INDEX JOB")
    print("Job ID:", job_id)
    print("Channel ID:", source_channel_id)
    print("Username:", source_username)
    print("=" * 60)
    print("")

    total_indexed = 0

    if not job_id:

        print(
            "ERROR: Job ID missing.",
            flush=True
        )

        return

    chat = get_source_chat(job)

    if not chat:

        complete_job(
            job_id,
            "failed",
            0,
            "Source channel not found"
        )

        return

    # -----------------------------------------------------
    # CHECK TELEGRAM CHANNEL
    # -----------------------------------------------------

    try:

        info = app.get_chat(chat)

        print(
            "Channel:",
            info.title,
            flush=True
        )

        print(
            "Username:",
            info.username or "",
            flush=True
        )

        print(
            "ID:",
            info.id,
            flush=True
        )

        # Use Telegram's actual ID.
        # This is important for private/public channels.
        source_channel_id = info.id

        if info.username:
            source_username = f"@{info.username}"

    except Exception as e:

        print(
            "Could not access source channel:",
            e,
            flush=True
        )

        complete_job(
            job_id,
            "failed",
            0,
            f"Cannot access source channel: {e}"
        )

        return

    # -----------------------------------------------------
    # INDEX OLD MESSAGES
    # -----------------------------------------------------

    try:

        print("")
        print(
            "Starting old message indexing...",
            flush=True
        )

        print(
            "Source:",
            source_username or source_channel_id,
            flush=True
        )

        print(
            "This may take some time for large channels.",
            flush=True
        )

        for message in app.get_chat_history(chat):

            try:

                movie = build_movie(
                    message,
                    source_channel_id,
                    source_username
                )

                if not movie:
                    continue

                success = send_movie(movie)

                if success:

                    total_indexed += 1

                    if total_indexed % 25 == 0:

                        print(
                            f"Indexed {total_indexed} movies...",
                            flush=True
                        )

                time.sleep(0.05)

            except FloodWait as e:

                print(
                    f"Telegram FloodWait: "
                    f"sleeping {e.value} seconds",
                    flush=True
                )

                time.sleep(
                    e.value + 2
                )

            except Exception as e:

                print(
                    "Message processing error:",
                    e,
                    flush=True
                )

        print("")
        print(
            "Indexing completed.",
            flush=True
        )

        print(
            "Total indexed:",
            total_indexed,
            flush=True
        )

        complete_job(
            job_id,
            "completed",
            total_indexed,
            ""
        )

    except FloodWait as e:

        print(
            f"Main FloodWait: sleeping "
            f"{e.value} seconds",
            flush=True
        )

        time.sleep(
            e.value + 2
        )

        complete_job(
            job_id,
            "failed",
            total_indexed,
            f"FloodWait: {e.value} seconds"
        )

    except RPCError as e:

        print(
            "Telegram RPC error:",
            e,
            flush=True
        )

        complete_job(
            job_id,
            "failed",
            total_indexed,
            str(e)
        )

    except Exception as e:

        print(
            "Indexing error:",
            e,
            flush=True
        )

        complete_job(
            job_id,
            "failed",
            total_indexed,
            str(e)
        )


# =========================================================
# MAIN INDEX LOOP
# =========================================================

def index_loop():

    print("")
    print("=" * 60)
    print("MOVIE CLOUD INDEXER")
    print("=" * 60)
    print("")

    print(
        "Connecting to Telegram...",
        flush=True
    )

    try:

        app.start()

        me = app.get_me()

        print("")
        print(
            "Telegram login successful!",
            flush=True
        )

        print(
            "Account:",
            me.first_name or "",
            flush=True
        )

        print(
            "Username:",
            me.username or "",
            flush=True
        )

        print(
            "User ID:",
            me.id,
            flush=True
        )

    except Exception as e:

        print("")
        print(
            "TELEGRAM LOGIN FAILED",
            flush=True
        )

        print(
            str(e),
            flush=True
        )

        print("")

        return

    print("")
    print(
        "Waiting for indexing jobs...",
        flush=True
    )

    print("")

    while True:

        try:

            job = get_job()

            if job:

                process_job(job)

            else:

                time.sleep(10)

        except Exception as e:

            print(
                "Main loop error:",
                e,
                flush=True
            )

            time.sleep(15)


# =========================================================
# START
# =========================================================

if __name__ == "__main__":

    # Render health server
    health_thread = threading.Thread(
        target=start_health_server,
        daemon=True
    )

    health_thread.start()

    # Telegram indexer
    index_loop()
