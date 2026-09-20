import asyncio
import os
import traceback
from typing import Optional

import aiohttp
from pyrogram import Client
from pyrogram.errors import FloodWait, RPCError


# =========================================================
# MOVIE UPDATE HD - AUTOMATIC INDEXER
# =========================================================

API_ID = int(os.getenv("API_ID", "0"))
API_HASH = os.getenv("API_HASH", "")
SESSION_STRING = os.getenv("SESSION_STRING", "")

# IMPORTANT:
# Only the base Worker URL should be stored in Render.
# Example:
# https://movieupdatehd-bot.krishnabasakfake.workers.dev
WORKER_URL = os.getenv(
    "WORKER_URL",
    "https://movieupdatehd-bot.krishnabasakfake.workers.dev"
).strip().rstrip("/")

INDEX_SECRET = os.getenv("INDEX_SECRET", "").strip()

POLL_SECONDS = int(os.getenv("POLL_SECONDS", "5"))
RETRY_SECONDS = int(os.getenv("RETRY_SECONDS", "15"))

BATCH_SIZE = 20
HTTP_TIMEOUT = 60


# =========================================================
# VALIDATION
# =========================================================

if not API_ID:
    raise RuntimeError("API_ID is missing")

if not API_HASH:
    raise RuntimeError("API_HASH is missing")

if not SESSION_STRING:
    raise RuntimeError("SESSION_STRING is missing")

if not INDEX_SECRET:
    raise RuntimeError("INDEX_SECRET is missing")


# =========================================================
# NORMALIZE WORKER URL
# =========================================================

# Prevent accidental values like:
# /index-job
# /index
# /index-job/
#
# The Render environment should contain only the base URL.

for suffix in (
    "/index-job/update",
    "/index-job",
    "/index-status",
    "/index",
):
    if WORKER_URL.endswith(suffix):
        WORKER_URL = WORKER_URL[: -len(suffix)].rstrip("/")


INDEX_JOB_URL = f"{WORKER_URL}/index-job"
INDEX_URL = f"{WORKER_URL}/index"
INDEX_JOB_UPDATE_URL = f"{WORKER_URL}/index-job/update"


# =========================================================
# TELEGRAM CLIENT
# =========================================================

app = Client(
    "movie_update_hd_indexer",
    api_id=API_ID,
    api_hash=API_HASH,
    session_string=SESSION_STRING,
)


# =========================================================
# HTTP SESSION
# =========================================================

http_session: Optional[aiohttp.ClientSession] = None


# =========================================================
# HTTP HELPERS
# =========================================================

def get_headers():
    return {
        "X-Index-Secret": INDEX_SECRET,
        "Content-Type": "application/json",
    }


def print_worker_config():
    print()
    print("==============================================")
    print(" WORKER CONFIGURATION")
    print("==============================================")
    print(f"Worker Base URL : {WORKER_URL}")
    print(f"GET Job URL     : {INDEX_JOB_URL}")
    print(f"POST Index URL  : {INDEX_URL}")
    print(f"Update Job URL  : {INDEX_JOB_UPDATE_URL}")
    print("==============================================")
    print()


async def worker_request(
    method: str,
    url: str,
    json_data=None,
    params=None,
):
    global http_session

    if http_session is None or http_session.closed:
        http_session = aiohttp.ClientSession()

    try:
        async with http_session.request(
            method=method,
            url=url,
            headers=get_headers(),
            json=json_data,
            params=params,
            timeout=aiohttp.ClientTimeout(total=HTTP_TIMEOUT),
        ) as response:

            text = await response.text()

            # -------------------------------------------------
            # Successful response
            # -------------------------------------------------

            if 200 <= response.status < 300:

                try:
                    return await response.json(
                        content_type=None
                    )

                except Exception:
                    return {
                        "ok": True,
                        "text": text,
                    }

            # -------------------------------------------------
            # Authentication error
            # -------------------------------------------------

            if response.status == 401:
                raise RuntimeError(
                    "Worker API returned 401 Unauthorized. "
                    "Check INDEX_SECRET in Render and Cloudflare."
                )

            # -------------------------------------------------
            # Not found
            # -------------------------------------------------

            if response.status == 404:
                raise RuntimeError(
                    f"Worker API returned 404 Not Found.\n"
                    f"URL: {url}\n"
                    f"Response: {text}"
                )

            # -------------------------------------------------
            # Other HTTP error
            # -------------------------------------------------

            raise RuntimeError(
                f"Worker API error {response.status}.\n"
                f"URL: {url}\n"
                f"Response: {text}"
            )

    except asyncio.TimeoutError:
        raise RuntimeError(
            f"Worker API timeout.\nURL: {url}"
        )

    except aiohttp.ClientError as error:
        raise RuntimeError(
            f"Worker connection error: {error}\n"
            f"URL: {url}"
        )


# =========================================================
# TELEGRAM MESSAGE HELPERS
# =========================================================

def message_text(message):
    if message.text:
        return message.text.strip()

    if message.caption:
        return message.caption.strip()

    return ""


def extract_title(message):

    text = message_text(message)

    if not text:
        return f"Movie {message.id}"

    lines = [
        line.strip()
        for line in text.splitlines()
        if line.strip()
    ]

    if not lines:
        return f"Movie {message.id}"

    title = lines[0]

    prefixes = [
        "movie:",
        "movie -",
        "movie",
        "title:",
        "title -",
        "film:",
        "film -",
    ]

    lower_title = title.lower()

    for prefix in prefixes:

        if lower_title.startswith(prefix):

            title = title[len(prefix):].strip()

            break

    title = title.strip(":-•| ")

    if not title:
        title = f"Movie {message.id}"

    return title[:300]


def extract_language(message):

    text = message_text(message).lower()

    languages = [
        "hindi",
        "english",
        "bengali",
        "bangla",
        "tamil",
        "telugu",
        "malayalam",
        "kannada",
        "marathi",
        "punjabi",
        "gujarati",
        "oriya",
        "odia",
        "urdu",
    ]

    for language in languages:

        if language in text:
            return language.title()

    return ""


def extract_quality(message):

    text = message_text(message).lower()

    qualities = [
        "2160p",
        "4k",
        "1440p",
        "1080p",
        "720p",
        "480p",
        "360p",
        "240p",
        "web-dl",
        "webdl",
        "bluray",
        "blu-ray",
        "hdrip",
        "webrip",
        "hdcam",
        "cam",
    ]

    for quality in qualities:

        if quality in text:
            return quality.upper()

    return ""


def extract_size(message):

    import re

    text = message_text(message)

    match = re.search(
        r"(\d+(?:\.\d+)?)\s*(GB|MB|KB)",
        text,
        re.IGNORECASE,
    )

    if match:

        return (
            f"{match.group(1)} "
            f"{match.group(2).upper()}"
        )

    return ""


def get_media_type(message):

    if message.video:
        return "video"

    if message.document:
        return "document"

    if message.audio:
        return "audio"

    if message.photo:
        return "photo"

    if message.animation:
        return "animation"

    if message.text:
        return "text"

    return "other"


# =========================================================
# GET NEXT INDEX JOB
# =========================================================

async def get_next_job():

    result = await worker_request(
        "GET",
        INDEX_JOB_URL,
    )

    if not result:
        return None

    if result.get("ok") is False:
        return None

    job = result.get("job")

    if not job:
        return None

    return job


# =========================================================
# SEND MOVIE TO CLOUDFLARE
# =========================================================

async def send_movie(message):

    chat = await app.get_chat(
        message.chat.id
    )

    source_username = ""

    if chat.username:
        source_username = f"@{chat.username}"

    payload = {
        "channel_id": str(message.chat.id),
        "message_id": int(message.id),

        "source_username": source_username,

        "title": extract_title(message),

        "language": extract_language(message),

        "quality": extract_quality(message),

        "size": extract_size(message),

        "media_type": get_media_type(message),

        "text": message_text(message),
    }

    return await worker_request(
        "POST",
        INDEX_URL,
        json_data=payload,
    )


# =========================================================
# UPDATE INDEX JOB
# =========================================================

async def update_job(
    job_id,
    status,
    total_indexed=None,
    last_message_id=None,
    error="",
):

    payload = {
        "job_id": int(job_id),
        "status": status,
    }

    if total_indexed is not None:

        payload["total_indexed"] = int(
            total_indexed
        )

    if last_message_id is not None:

        payload["last_message_id"] = int(
            last_message_id
        )

    if error:

        payload["error"] = str(error)[:2000]

    return await worker_request(
        "POST",
        INDEX_JOB_UPDATE_URL,
        json_data=payload,
    )


# =========================================================
# INDEX ONE MESSAGE
# =========================================================

async def index_one_message(
    message,
    total_indexed,
):

    try:

        await send_movie(message)

        total_indexed += 1

        return total_indexed, True

    except FloodWait as error:

        print(
            f"Telegram FloodWait: "
            f"{error.value} seconds"
        )

        await asyncio.sleep(
            error.value
        )

        try:

            await send_movie(message)

            total_indexed += 1

            return total_indexed, True

        except Exception as retry_error:

            print(
                "Retry failed:",
                retry_error,
            )

            return total_indexed, False

    except Exception as error:

        print(
            f"Message {message.id} failed:",
            error,
        )

        return total_indexed, False


# =========================================================
# PROCESS INDEX JOB
# =========================================================

async def process_job(job):

    job_id = int(job["id"])

    chat_id = job["source_channel_id"]

    source_username = (
        job.get("source_username")
        or ""
    )

    total_indexed = int(
        job.get("total_indexed") or 0
    )

    last_message_id = int(
        job.get("last_message_id") or 0
    )

    print()
    print("==============================================")
    print(" NEW INDEX JOB")
    print("==============================================")
    print(f"Job ID          : {job_id}")
    print(f"Source Channel  : {chat_id}")
    print(f"Username        : {source_username}")
    print(f"Already Indexed : {total_indexed}")
    print(f"Last Message ID : {last_message_id}")
    print("==============================================")
    print()

    try:

        # -------------------------------------------------
        # Connect to source
        # -------------------------------------------------

        chat = await app.get_chat(
            chat_id
        )

        chat_name = (
            chat.title
            or chat.username
            or str(chat.id)
        )

        print(
            f"Connected to source: {chat_name}"
        )

        print(
            f"Starting history from message ID "
            f"{last_message_id}"
        )

        # -------------------------------------------------
        # Mark job running
        # -------------------------------------------------

        await update_job(
            job_id,
            "running",
            total_indexed,
            last_message_id,
        )

        # -------------------------------------------------
        # IMPORTANT:
        #
        # get_chat_history returns newest -> oldest.
        #
        # We collect messages and process them oldest
        # -> newest inside each batch.
        #
        # offset_id is intentionally NOT used here.
        # We use message IDs to resume safely.
        # -------------------------------------------------

        batch = []

        async for message in app.get_chat_history(
            chat.id
        ):

            # Skip messages already indexed
            if message.id <= last_message_id:
                continue

            # Skip service messages
            if message.service:
                last_message_id = max(
                    last_message_id,
                    message.id
                )
                continue

            batch.append(message)

            if len(batch) >= BATCH_SIZE:

                # Oldest first
                batch.reverse()

                for item in batch:

                    (
                        total_indexed,
                        success,
                    ) = await index_one_message(
                        item,
                        total_indexed,
                    )

                    # Always move progress forward
                    last_message_id = max(
                        last_message_id,
                        item.id,
                    )

                batch.clear()

                await update_job(
                    job_id,
                    "running",
                    total_indexed,
                    last_message_id,
                )

                print(
                    f"Progress -> "
                    f"Indexed: {total_indexed} | "
                    f"Last ID: {last_message_id}"
                )

        # -------------------------------------------------
        # Remaining messages
        # -------------------------------------------------

        if batch:

            batch.reverse()

            for item in batch:

                (
                    total_indexed,
                    success,
                ) = await index_one_message(
                    item,
                    total_indexed,
                )

                last_message_id = max(
                    last_message_id,
                    item.id,
                )

            await update_job(
                job_id,
                "running",
                total_indexed,
                last_message_id,
            )

        # -------------------------------------------------
        # COMPLETED
        # -------------------------------------------------

        await update_job(
            job_id,
            "completed",
            total_indexed,
            last_message_id,
        )

        print()
        print("==============================================")
        print(" INDEX JOB COMPLETED")
        print("==============================================")
        print(f"Job ID          : {job_id}")
        print(f"Total Indexed   : {total_indexed}")
        print(f"Last Message ID : {last_message_id}")
        print("==============================================")
        print()

    except FloodWait as error:

        print()
        print("==============================================")
        print(" FLOOD WAIT")
        print("==============================================")
        print(
            f"Sleeping {error.value} seconds..."
        )
        print("==============================================")

        await asyncio.sleep(
            error.value
        )

        await update_job(
            job_id,
            "pending",
            total_indexed,
            last_message_id,
            f"FloodWait: {error.value}",
        )

    except RPCError as error:

        print()
        print("==============================================")
        print(" TELEGRAM RPC ERROR")
        print("==============================================")
        print(error)
        print("==============================================")

        try:

            await update_job(
                job_id,
                "pending",
                total_indexed,
                last_message_id,
                str(error),
            )

        except Exception:
            pass

        await asyncio.sleep(
            RETRY_SECONDS
        )

    except Exception as error:

        print()
        print("==============================================")
        print(" INDEX JOB ERROR")
        print("==============================================")
        print(error)
        traceback.print_exc()
        print("==============================================")
        print()

        try:

            await update_job(
                job_id,
                "pending",
                total_indexed,
                last_message_id,
                str(error),
            )

        except Exception as update_error:

            print(
                "Could not update job:",
                update_error,
            )

        await asyncio.sleep(
            RETRY_SECONDS
        )


# =========================================================
# MAIN LOOP
# =========================================================

async def main():

    print()
    print("==============================================")
    print(" MOVIE UPDATE HD")
    print(" AUTOMATIC MOVIE INDEXER")
    print("==============================================")
    print()

    print_worker_config()

    print(
        f"Polling every {POLL_SECONDS} seconds"
    )

    print()

    print(
        "Starting Telegram client..."
    )

    print()

    await app.start()

    me = await app.get_me()

    print("Telegram account connected:")
    print(f"ID       : {me.id}")

    if me.username:
        print(
            f"Username : @{me.username}"
        )
    else:
        print(
            "Username : None"
        )

    print()

    print("==============================================")
    print(" INDEXER IS READY")
    print(" Waiting for index jobs...")
    print("==============================================")
    print()

    while True:

        try:

            job = await get_next_job()

            if job:

                await process_job(
                    job
                )

            else:

                await asyncio.sleep(
                    POLL_SECONDS
                )

        except KeyboardInterrupt:

            print(
                "Indexer stopped."
            )

            break

        except Exception as error:

            print()
            print("==============================================")
            print(" MAIN LOOP ERROR")
            print("==============================================")
            print(error)
            traceback.print_exc()
            print("==============================================")
            print()

            await asyncio.sleep(
                RETRY_SECONDS
            )


# =========================================================
# SHUTDOWN
# =========================================================

async def shutdown():

    global http_session

    try:

        if app.is_connected:

            await app.stop()

    except Exception:

        pass

    try:

        if http_session and not http_session.closed:

            await http_session.close()

    except Exception:

        pass


# =========================================================
# RUN
# =========================================================

if __name__ == "__main__":

    try:

        asyncio.run(
            main()
        )

    except KeyboardInterrupt:

        print(
            "Indexer stopped."
        )

    except Exception as error:

        print()
        print("==============================================")
        print(" FATAL ERROR")
        print("==============================================")
        print(error)
        traceback.print_exc()
        print("==============================================")
