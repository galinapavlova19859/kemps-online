# Kemps Online

An online multiplayer version of the card game Kemps, for 4 or 6 players in teams of two.

## Run locally

You need Node.js 18 or newer. The game has no other dependencies.

```
node server.js
```

Open http://localhost:3000. To play locally against yourself, open 4 browser tabs. Each tab is a separate player.

## Deploy (so friends can join)

Any host that runs Node works. The simplest options are Render, Railway, or Fly.io:

1. Push this folder to a GitHub repository.
2. Create a new **Web Service** from that repository.
3. Set the start command to `npm start`. The server reads the `PORT` environment variable the host provides.

Games are kept in memory, so a server restart ends any game in progress.

## How online Kemps works

- The host creates a game and shares the 4-letter code or the invite link.
- Players pick seats. Partners sit opposite each other, so seats of the same color are one team.
- Each team picks a secret signal emote. Only that team can see which emote it chose.
- Swap cards at any time, in real time, with no turns. Click a card in your hand, then a card in the middle. On a keyboard, `1`–`4` picks a hand card, `Q` `W` `E` `R` picks a middle card, and `K` calls KEMPS.
- Anyone can send any emote at any time, so you can bluff.
- **KEMPS!** checks your partner's hand. If they have four of a kind, your team scores. If they don't, the point goes to the other team (with 6 players, to the next team around the table).
- **Counter!** on an opponent checks their hand. If they have four of a kind, your team scores. If they don't, their team scores.
- After every call there's a short break. All hands are shown, and each team can pick a new secret signal. The next round starts when every human player clicks **Ready**, or after 12 seconds. Teams made of two bots sometimes change their signal too.
- When the middle goes stale, every player can vote to refresh it. All players must agree.
- The host can fill empty seats with **bots** (the **+ Bot** button in the lobby). Bots collect four of a kind and send their team's signal when they have it. They call KEMPS when their partner (bot or human) sends that team's signal, and bluff with other emotes now and then. They also remember emotes that came right before a correct call, and use that to call Counter. A bot calls KEMPS whenever you send your team's signal, so only send it when you really have four of a kind.
