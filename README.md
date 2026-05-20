# LinkedIn → Notion

Export your saved LinkedIn posts to a Notion database in one command.

## Setup (2 minutes)

### 1. Get your LinkedIn cookie

1. Open [linkedin.com](https://linkedin.com) in Chrome
2. Press `F12` → **Application** tab → **Cookies** → `https://www.linkedin.com`
3. Copy the value of `li_at`

### 2. Create a Notion integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **New integration** → give it a name → **Submit**
3. Copy the **Internal Integration Secret** (starts with `ntn_`)

### 3. Prepare your Notion database

1. Create a new database in Notion (or use an existing one)
2. Click **...** → **Connections** → add your integration
3. Copy the database ID from the URL:
   ```
   notion.so/DATABASE_ID?v=...
   ```

## Run

```bash
npx linkedin-to-notion
```

The CLI will prompt you for:
- Your `li_at` cookie
- Your Notion token
- Your database ID

It automatically:
- Creates the required columns (Auteur, Headline, URL, Date)
- Skips posts already in the database
- Fetches full post content
- Adds the post body as page content in Notion

## What you get

| Column | Description |
|--------|-------------|
| Nom | Author + post preview |
| Auteur | Post author name |
| Headline | Author's LinkedIn headline |
| URL | Direct link to the post |
| Date | Approximate save date |
| Page content | Full post text |

## Notes

- The `li_at` cookie is valid for ~1 year
- LinkedIn's internal API has rate limits — the script includes delays between requests
- Run it again anytime to sync new saved posts (duplicates are skipped)
