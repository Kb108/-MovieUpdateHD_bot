from pyrogram import Client

API_ID = int(input("Enter API_ID: "))
API_HASH = input("Enter API_HASH: ")

app = Client(
    "movie_session",
    api_id=API_ID,
    api_hash=API_HASH
)

with app:
    print("\nSESSION_STRING:")
    print(app.export_session_string())
    print("\nCopy the SESSION_STRING above.")
