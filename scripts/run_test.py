import asyncio
from chzzkpy import Client, Donation, Message, UserPermission

client_id = "30454343-f614-4087-97a6-62c57ae3b4d7"
client_secret = "7u_FwoWHaVAF9BJyBKiDBPPLZWfVzpJHPzXtBg-MDaA"
client = Client(client_id, client_secret)

@client.event
async def on_chat(message: Message):
    if message.content == "!안녕":
        await message.send("%s님, 안녕하세요!" % message.profile.nickname)


@client.event
async def on_donation(donation: Donation):
    await donation.send("%s님, %d원 후원 감사합니다." % (donation.profile.nickname, donation.pay_amount))

@client.event
async def on_connect():
    logger.success("연결에 성공했습니다.")

async def main():
    user_client = await client.login()
    await user_client.connect(UserPermission.all())

asyncio.run(main())