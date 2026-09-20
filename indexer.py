import os
import asyncio
import logging
import re
from html import unescape

import aiohttp
from pyrogram import Client
from pyrogram.errors import FloodWait, RPCError


# ============================================================
# CONFIG
# ============================================================

API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]
SESSION_STRING = os.environ["SESSION_STRING"]

WORKER_URL = os.environ["WORKER_URL"].rstrip("/")
INDEX_SECRET = os.environ["INDEX_SECRET"]

POLL_SECONDS = int(os.getenv("POLL_SECONDS", "5"))
RETRY_SECONDS = int(os.getenv("RETRY_SECONDS", "15"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s"
)

logger = logging.getLogger("MovieUpdateHDIndexer")


# ============================================================
# PYROGRAM CLIENT
# ============================================================

app = Client(
    "movie_update_hd_indexer",
    api_id=API_ID,
    api_hash=API_HASH,
    session_string=SESSION_STRING,
)


# ============================================================
# HTTP SESSION
# ============================================================

http_session = None


def headers():
    return {
        "X-Index-Secret": INDEX_SECRET,
        "Content-Type": "application/json",
    }


# ============================================================
# TEXT CLEANING
# ============================================================

def clean_text(text):
    if not text:
        return ""

    text = unescape(str(text))

    text = text.replace("\r", "\n")

    # Remove excessive spaces
    text = re.sub(r"[ \t]+", " ", text)

    # Remove excessive empty lines
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()


# ============================================================
# MOVIE TITLE EXTRACTION
# ============================================================

def extract_title(message, fallback="Movie"):
    text = ""

    if message.text:
        text = message.text

    elif message.caption:
        text = message.caption

    text = clean_text(text)

    if not text:
        return fallback

    lines = [
        x.strip()
        for x in text.split("\n")
        if x.strip()
    ]

    if not lines:
        return fallback

    # Ignore common decorative lines
    ignored = [
        "download",
        "watch now",
        "click here",
        "movie",
        "full movie",
        "telegram",
    ]

    for line in lines:

        low = line.lower()

        if len(line) < 2:
            continue

        if any(x == low for x in ignored):
            continue

        # Ignore lines made mostly of symbols
        alnum_count = sum(c.isalnum() for c in line)

        if alnum_count < 2:
            continue

        # Remove common emojis/symbols from beginning
        line = re.sub(
            r"^[\W_]+",
            "",
            line,
            flags=re.UNICODE
        ).strip()

        if len(line) >= 2:
            return line[:500]

    return fallback


# ============================================================
# LANGUAGE EXTRACTION
# ============================================================

def extract_language(text):
    if not text:
        return ""

    low = text.lower()

    languages = [
        ("Bangla", ["bangla", "bengali"]),
        ("Hindi", ["hindi"]),
        ("English", ["english"]),
        ("Tamil", ["tamil"]),
        ("Telugu", ["telugu"]),
        ("Malayalam", ["malayalam"]),
        ("Kannada", ["kannada"]),
        ("Punjabi", ["punjabi"]),
        ("Marathi", ["marathi"]),
        ("Korean", ["korean"]),
        ("Japanese", ["japanese"]),
        ("Chinese", ["chinese"]),
    ]

    for name, words in languages:
        for word in words:
            if word in low:
                return name

    return ""


# ============================================================
# QUALITY EXTRACTION
# ============================================================

def extract_quality(text):
    if not text:
        return ""

    patterns = [
        r"\b2160p\b",
        r"\b1440p\b",
        r"\b1080p\b",
        r"\b720p\b",
        r"\b480p\b",
        r"\b360p\b",
        r"\b4K\b",
        r"\b2K\b",
        r"\bWEB-DL\b",
        r"\bWEBRip\b",
        r"\bBluRay\b",
        r"\bHDRip\b",
        r"\bHDTV\b",
    ]

    for pattern in patterns:
        match = re.search(
            pattern,
            text,
            re.IGNORECASE
        )

        if match:
            return match.group(0)

    return ""


# ============================================================
# SIZE EXTRACTION
# ============================================================

def extract_size(text):
    if not text:
        return ""

    pattern = r"\b\d+(?:\.\d+)?\s*(?:GB|MB|TB)\b"

    match = re.search(
        pattern,
        text,
        re.IGNORECASE
    )

    if match:
        return match.group(0)

    return ""


# ============================================================
# GET MESSAGE TEXT
# ============================================================

def get_message_text(message):
    if message.text:
        return message.text

    if message.caption:
        return message.caption

    return ""


# ============================================================
# GET CHANNEL USERNAME
# ============================================================

async def get_channel_username(chat_id):
    try:
        chat = await app.get_chat(chat_id)

        username = getattr(chat, "username", None)

        if username:
            return "@" + username

    except Exception as e:
        logger.warning(
            "Could not get username for %s: %s",
            chat_id,
            e
        )

    return ""


# ============================================================
# GET CHANNEL TITLE
# ============================================================

async def get_channel_title(chat_id):
    try:
        chat = await app.get_chat(chat_id)

        title = getattr(chat, "title", None)

        if title:
            return title

    except Exception as e:
        logger.warning(
            "Could not get channel title: %s",
            e
        )

    return ""


# ============================================================
# API REQUEST
# ============================================================

async def api_request(
    method,
    endpoint,
    json_data=None,
    params=None,
):
    url = WORKER_URL + endpoint

    for attempt in range(1, 6):

        try:

            async with http_session.request(
                method,
                url,
                headers=headers(),
                json=json_data,
                params=params,
                timeout=aiohttp.ClientTimeout(
                    total=60
                ),
            ) as response:

                text = await response.text()

                if response.status >= 400:
                    raise RuntimeError(
                        f"HTTP {response.status}: {text[:500]}"
                    )

                if not text:
                    return {}

                try:
                    return await response.json(
                        content_type=None
                    )

                except Exception:
                    return {
                        "raw": text
                    }

        except Exception as e:

            logger.error(
                "API request failed (%s/5): %s",
                attempt,
                e
            )

            if attempt < 5:
                await asyncio.sleep(RETRY_SECONDS)

            else:
                raise


# ============================================================
# GET NEXT INDEX JOB
# ============================================================

async def get_next_job():

    try:

        data = await api_request(
            "GET",
            "/index-job"
        )

        # Expected:
        # { "job": {...} }

        if not isinstance(data, dict):
            return None

        job = data.get("job")

        if not job:
            return None

        return job

    except Exception as e:

        logger.error(
            "Could not get index job: %s",
            e
        )

        return None


# ============================================================
# UPDATE JOB
# ============================================================

async def update_job(
    job_id,
    status=None,
    total_indexed=None,
    last_message_id=None,
    error=None,
):

    payload = {
        "id": job_id
    }

    if status is not None:
        payload["status"] = status

    if total_indexed is not None:
        payload["total_indexed"] = total_indexed

    if last_message_id is not None:
        payload["last_message_id"] = last_message_id

    if error is not None:
        payload["error"] = str(error)[:2000]

    try:

        await api_request(
            "POST",
            "/index-job/update",
            json_data=payload
        )

    except Exception as e:

        logger.error(
            "Job update failed: %s",
            e
        )


# ============================================================
# INDEX ONE MOVIE
# ============================================================

async def index_movie(
    message,
    channel_id,
    channel_username,
    channel_title,
):

    text = get_message_text(message)

    title = extract_title(
        message,
        fallback=channel_title or "Movie"
    )

    language = extract_language(text)

    quality = extract_quality(text)

    size = extract_size(text)

    payload = {
        "title": title,
        "language": language,
        "quality": quality,
        "size": size,
        "poster": "",
        "channel_id": str(channel_id),
        "message_id": int(message.id),
        "source_username": channel_username,
    }

    await api_request(
        "POST",
        "/index",
        json_data=payload
    )

    return title


# ============================================================
# PROCESS JOB
# ============================================================

async def process_job(job):

    job_id = job.get("id")

    source_channel_id = job.get(
        "source_channel_id"
    )

    source_username = job.get(
        "source_username",
        ""
    )

    source_title = job.get(
        "source_title",
        ""
    )

    total_indexed = int(
        job.get(
            "total_indexed",
            0
        ) or 0
    )

    last_message_id = int(
        job.get(
            "last_message_id",
            0
        ) or 0
    )

    if not source_channel_id:
        await update_job(
            job_id,
            status="failed",
            error="Source channel ID is missing"
        )
        return

    logger.info(
        "Starting job %s | Channel: %s",
        job_id,
        source_channel_id
    )

    try:

        # ----------------------------------------------------
        # Check channel access
        # ----------------------------------------------------

        chat = await app.get_chat(
            int(source_channel_id)
        )

        actual_title = (
            getattr(chat, "title", None)
            or source_title
            or ""
        )

        actual_username = (
            getattr(chat, "username", None)
        )

        if actual_username:
            actual_username = (
                "@" + actual_username
            )

        elif source_username:
            actual_username = source_username

        else:
            actual_username = ""

        logger.info(
            "Connected to channel: %s %s",
            actual_title,
            actual_username
        )

        # ----------------------------------------------------
        # Resume from last message
        # ----------------------------------------------------

        offset_id = last_message_id

        processed_since_update = 0

        async for message in app.get_chat_history(
            chat.id,
            offset_id=offset_id
        ):

            # Ignore empty service messages
            if (
                not message.text
                and not message.caption
                and not message.media
            ):
                continue

            try:

                title = await index_movie(
                    message=message,
                    channel_id=chat.id,
                    channel_username=actual_username,
                    channel_title=actual_title,
                )

                total_indexed += 1
                processed_since_update += 1

                # Save progress
                if (
                    processed_since_update >= 10
                    or total_indexed == 1
                ):

                    await update_job(
                        job_id,
                        status="running",
                        total_indexed=total_indexed,
                        last_message_id=message.id,
                        error=""
                    )

                    processed_since_update = 0

                    logger.info(
                        "Job %s | Indexed: %s | Last ID: %s | %s",
                        job_id,
                        total_indexed,
                        message.id,
                        title[:80]
                    )

            except FloodWait as e:

                logger.warning(
                    "FloodWait: sleeping %s seconds",
                    e.value
                )

                await asyncio.sleep(e.value)

            except Exception as e:

                logger.error(
                    "Message %s failed: %s",
                    message.id,
                    e
                )

                # Continue with next movie
                continue

        # ----------------------------------------------------
        # FINAL UPDATE
        # ----------------------------------------------------

        await update_job(
            job_id,
            status="completed",
            total_indexed=total_indexed,
            last_message_id=last_message_id,
            error=""
        )

        logger.info(
            "JOB %s COMPLETED | Total: %s",
            job_id,
            total_indexed
        )

    except FloodWait as e:

        logger.warning(
            "FloodWait outside loop: %s seconds",
            e.value
        )

        await asyncio.sleep(e.value)

        await update_job(
            job_id,
            status="pending",
            total_indexed=total_indexed,
            last_message_id=last_message_id,
            error=f"FloodWait: {e.value}"
        )

    except RPCError as e:

        logger.error(
            "Telegram RPC error: %s",
            e
        )

        await update_job(
            job_id,
            status="pending",
            total_indexed=total_indexed,
            last_message_id=last_message_id,
            error=str(e)
        )

    except Exception as e:

        logger.exception(
            "Job %s failed",
            job_id
        )

        await update_job(
            job_id,
            status="pending",
            total_indexed=total_indexed,
            last_message_id=last_message_id,
            error=str(e)
        )


# ============================================================
# MAIN WORKER LOOP
# ============================================================

async def worker_loop():

    logger.info(
        "Movie Update HD Automatic Indexer Started"
    )

    while True:

        try:

            job = await get_next_job()

            if job:

                logger.info(
                    "New indexing job received: %s",
                    job.get("id")
                )

                await process_job(job)

            else:

                await asyncio.sleep(
                    POLL_SECONDS
                )

        except Exception as e:

            logger.exception(
                "Worker loop error: %s",
                e
            )

            await asyncio.sleep(
                RETRY_SECONDS
            )


# ============================================================
# START
# ============================================================

async def main():

    global http_session

    http_session = aiohttp.ClientSession()

    try:

        await app.start()

        me = await app.get_me()

        logger.info(
            "Telegram account connected: @%s",
            me.username or me.first_name
        )

        logger.info(
            "Worker URL: %s",
            WORKER_URL
        )

        await worker_loop()

    finally:

        if http_session:
            await http_session.close()

        try:
            await app.stop()
        except Exception:
            pass


if __name__ == "__main__":

    asyncio.run(main())
