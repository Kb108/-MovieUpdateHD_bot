import asyncio
import os
import traceback
from typing import Optional

import aiohttp
from pyrogram import Client
from pyrogram.errors import FloodWait, RPCError


# =========================================================
# CONFIG
# =========================================================

API_ID = int(os.getenv("API_ID", "0"))
API_HASH = os.getenv("API_HASH", "")
SESSION_STRING = os.getenv("SESSION_STRING", "")

WORKER_URL = os.getenv(
    "WORKER_URL",
    "https://movieupdatehd-bot.krishnabasakfake.workers.dev"
).rstrip("/")

INDEX_SECRET = os.getenv("INDEX_SECRET", "")

POLL_SECONDS = int(os.getenv("POLL_SECONDS", "5"))
RETRY_SECONDS = int(os.getenv("RETRY_SECONDS", "15"))

BATCH_SIZE = 20


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
# TELEGRAM CLIENT
# =========================================================

app = Client(
    "movie_update_hd_indexer",
    api_id=API_ID,
    api_hash=API_HASH,
    session_string=SESSION_STRING
)


# =========================================================
# HTTP SESSION
# =========================================================

http_session: Optional[aiohttp.ClientSession] = None


# =========================================================
# HELPERS
# =========================================================

def headers():
    return {
        "X-Index-Secret": INDEX_SECRET,
        "Content-Type": "application/json"
    }


def message_text(message):
    text = ""

    if message.text:
        text = message.text

    elif message.caption:
        text = message.caption

    return text.strip()


def extract_title(message):
    text = message_text(message)

    if not text:
        return f"Movie {message.id}"

    lines = [
        x.strip()
        for x in text.splitlines()
        if x.strip()
    ]

    if not lines:
        return f"Movie {message.id}"

    title = lines[0]

    # Remove common prefixes
    prefixes = [
        "movie:",
        "movie -",
        "movie",
        "title:",
        "title -",
        "film:",
        "film -"
    ]

    lower = title.lower()

    for prefix in prefixes:
        if lower.startswith(prefix):
            title = title[len(prefix):].strip()
            break

    # Remove excessive formatting
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
        "urdu"
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
        "cam"
    ]

    for quality in qualities:
        if quality in text:
            return quality.upper()

    return ""


def extract_size(message):
    text = message_text(message)

    import re

    match = re.search(
        r"(\d+(?:\.\d+)?)\s*(GB|MB|KB)",
        text,
        re.IGNORECASE
    )

    if match:
        return f"{match.group(1)} {match.group(2).upper()}"

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
# WORKER API
# =========================================================

async def worker_request(
    method: str,
    path: str,
    json_data=None,
    params=None
):
    global http_session

    if http_session is None:
        http_session = aiohttp.ClientSession()

    url = f"{WORKER_URL}{path}"

    try:
        async with http_session.request(
            method,
            url,
            headers=headers(),
            json=json_data,
            params=params,
            timeout=aiohttp.ClientTimeout(total=60)
        ) as response:

            text = await response.text()

            if response.status >= 400:
                raise RuntimeError(
                    f"Worker API error {response.status}: {text}"
                )

            try:
                return await response.json()
            except Exception:
                return {
                    "ok": True,
                    "text": text
                }

    except Exception:
        raise


# =========================================================
# GET NEXT JOB
# =========================================================

async def get_next_job():
    result = await worker_request(
        "GET",
        "/index-job"
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
# SEND MOVIE TO WORKER
# =========================================================

async def send_movie(
    job,
    message
):
    chat = await app.get_chat(message.chat.id)

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

        "text": message_text(message)
    }

    await worker_request(
        "POST",
        "/index",
        json_data=payload
    )


# =========================================================
# UPDATE JOB
# =========================================================

async def update_job(
    job_id,
    status,
    total_indexed=None,
    last_message_id=None,
    error=""
):
    payload = {
        "job_id": int(job_id),
        "status": status
    }

    if total_indexed is not None:
        payload["total_indexed"] = int(total_indexed)

    if last_message_id is not None:
        payload["last_message_id"] = int(last_message_id)

    if error:
        payload["error"] = str(error)[:2000]

    return await worker_request(
        "POST",
        "/index-job/update",
        json_data=payload
    )


# =========================================================
# PROCESS JOB
# =========================================================

async def process_job(job):
    job_id = job["id"]

    chat_id = job["source_channel_id"]

    source_username = job.get("source_username", "")

    last_message_id = int(
        job.get("last_message_id") or 0
    )

    total_indexed = int(
        job.get("total_indexed") or 0
    )

    print()
    print("====================================")
    print("NEW INDEX JOB")
    print("====================================")
    print(f"Job ID: {job_id}")
    print(f"Source: {chat_id}")
    print(f"Username: {source_username}")
    print(f"Already indexed: {total_indexed}")
    print(f"Last message ID: {last_message_id}")
    print("====================================")

    try:
        chat = await app.get_chat(chat_id)

        print(
            f"Connected to source: "
            f"{chat.title or chat.username or chat.id}"
        )

        messages_batch = []

        # -------------------------------------------------
        # Telegram history
        # -------------------------------------------------

        async for message in app.get_chat_history(
            chat.id,
            offset_id=last_message_id
        ):

            if message.id <= last_message_id:
                continue

            messages_batch.append(message)

            if len(messages_batch) >= BATCH_SIZE:

                for item in reversed(messages_batch):

                    try:
                        await send_movie(
                            job,
                            item
                        )

                        total_indexed += 1

                    except FloodWait as e:
                        print(
                            f"FloodWait: sleeping {e.value} seconds"
                        )

                        await asyncio.sleep(e.value)

                        try:
                            await send_movie(
                                job,
                                item
                            )

                            total_indexed += 1

                        except Exception as retry_error:
                            print(
                                "Retry error:",
                                retry_error
                            )

                    except Exception as item_error:
                        print(
                            "Message index error:",
                            item_error
                        )

                    last_message_id = max(
                        last_message_id,
                        item.id
                    )

                messages_batch.clear()

                await update_job(
                    job_id,
                    "running",
                    total_indexed,
                    last_message_id
                )

                print(
                    f"Indexed: {total_indexed} | "
                    f"Last ID: {last_message_id}"
                )

        # -------------------------------------------------
        # Remaining messages
        # -------------------------------------------------

        for item in reversed(messages_batch):

            try:
                await send_movie(
                    job,
                    item
                )

                total_indexed += 1

            except FloodWait as e:
                print(
                    f"FloodWait: sleeping {e.value} seconds"
                )

                await asyncio.sleep(e.value)

                try:
                    await send_movie(
                        job,
                        item
                    )

                    total_indexed += 1

                except Exception as retry_error:
                    print(
                        "Retry error:",
                        retry_error
                    )

            except Exception as item_error:
                print(
                    "Message index error:",
                    item_error
                )

            last_message_id = max(
                last_message_id,
                item.id
            )

        await update_job(
            job_id,
            "completed",
            total_indexed,
            last_message_id
        )

        print()
        print("====================================")
        print("INDEX JOB COMPLETED")
        print("====================================")
        print(f"Job ID: {job_id}")
        print(f"Total indexed: {total_indexed}")
        print(f"Last message ID: {last_message_id}")
        print("====================================")

    except FloodWait as e:

        print(
            f"FloodWait outside loop: "
            f"{e.value} seconds"
        )

        await asyncio.sleep(e.value)

        await update_job(
            job_id,
            "pending",
            total_indexed,
            last_message_id,
            f"FloodWait: {e.value}"
        )

    except Exception as error:

        print()
        print("====================================")
        print("INDEX JOB FAILED")
        print("====================================")
        print(str(error))
        traceback.print_exc()
        print("====================================")

        await update_job(
            job_id,
            "pending",
            total_indexed,
            last_message_id,
            str(error)
        )


# =========================================================
# MAIN LOOP
# =========================================================

async def main():
    print()
    print("====================================")
    print(" Movie Update HD Automatic Indexer")
    print("====================================")
    print()
    print(f"Worker URL: {WORKER_URL}")
    print(f"Poll: {POLL_SECONDS}s")
    print()
    print("Starting Telegram client...")
    print()

    await app.start()

    me = await app.get_me()

    print("Telegram account connected:")
    print(f"ID: {me.id}")
    print(f"Username: @{me.username}" if me.username else "Username: None")
    print()

    while True:

        try:

            job = await get_next_job()

            if job:

                await process_job(job)

            else:

                await asyncio.sleep(
                    POLL_SECONDS
                )

        except KeyboardInterrupt:
            break

        except Exception as error:

            print()
            print("Main loop error:")
            print(error)
            traceback.print_exc()
            print()

            await asyncio.sleep(
                RETRY_SECONDS
            )


async def shutdown():
    global http_session

    try:
        await app.stop()
    except Exception:
        pass

    if http_session:
        await http_session.close()


if __name__ == "__main__":

    try:
        asyncio.run(main())

    except KeyboardInterrupt:
        print("Indexer stopped.")
