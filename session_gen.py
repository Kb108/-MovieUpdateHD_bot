import asyncio
import os

from pyrogram import Client


API_ID = int(os.getenv("API_ID", "0"))
API_HASH = os.getenv("API_HASH", "")


async def main():
    if not API_ID or not API_HASH:
        print("ERROR: API_ID and API_HASH are required.")
        print()
        print("Example:")
        print("API_ID=123456")
        print("API_HASH=xxxxxxxxxxxxxxxxxxxxxxxx")
        return

    print()
    print("====================================")
    print(" Movie Update HD - Session Generator")
    print("====================================")
    print()

    app = Client(
        "movie_update_hd_session",
        api_id=API_ID,
        api_hash=API_HASH
    )

    async with app:
        session_string = await app.export_session_string()

        print()
        print("====================================")
        print("SESSION STRING")
        print("====================================")
        print()
        print(session_string)
        print()
        print("====================================")
        print("Save this as SESSION_STRING")
        print("====================================")


if __name__ == "__main__":
    asyncio.run(main())
