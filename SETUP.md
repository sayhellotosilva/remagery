# Remagery web app: setup

Three free accounts, about 30–45 minutes in total. Do them in this order.

1. **GitHub Pages** puts the app online, so you and your friends get a link.
2. **Google Cloud** makes the voice (4 million free characters a month).
3. **Cloudflare** runs the small voice server, which keeps your Google key secret and stops before the free limit.

Until step 3 is done, the app still works, but with the browser's own voice, which stops when the phone locks.

---

## 1. Put the app online (GitHub Pages)

1. Go to github.com and sign in.
2. Click **+** (top right) › **New repository**.
3. Name: `remagery`. Choose **Public**. Click **Create repository**.
4. On the next page, click **uploading an existing file**.
5. Drag in everything from the `Web` folder **except** the `voice-server` folder. Include the `js` folder.
6. Click **Commit changes**.
7. Go to **Settings** › **Pages**.
8. Under "Branch", choose **main** and **/(root)**, then click **Save**.
9. Wait 1–2 minutes. The address appears at the top of that page, for example `https://yourname.github.io/remagery/`.

Open it in Safari on your iPhone. Tap **Share** › **Add to Home Screen**.

## 2. Turn on the Google voice (Google Cloud)

1. Go to console.cloud.google.com and sign in with your Google account.
2. At the top, click the project menu › **New project**. Name: `Remagery`. Click **Create**.
3. Google asks for a billing account and a card. This is needed even for the free allowance. Remagery's voice server stops at 3.8 million characters a month, below the free 4 million.
4. In the search bar, type **Cloud Text-to-Speech API**. Open it and click **Enable**.
5. Search for **Credentials**. Click **Create credentials** › **API key**.
6. Click **Edit API key** (or the key's name):
   - Under "API restrictions", choose **Restrict key** and tick only **Cloud Text-to-Speech API**.
   - Click **Save**.
7. Copy the key. You'll paste it in Cloudflare in the next step. Don't share it.
8. Optional but recommended: search for **Budgets & alerts** and make a budget of €1, so Google emails you if anything is ever charged.

## 3. Set up the voice server (Cloudflare)

1. Go to dash.cloudflare.com and make a free account.
2. In the left menu: **Storage & Databases** › **KV** › **Create**. Name: `remagery-usage`. Click **Add**.
3. In the left menu: **Compute (Workers)** › **Workers & Pages** › **Create** › **Create Worker**.
4. Name: `remagery-voice`. Click **Deploy**.
5. Click **Edit code**. Delete everything in the editor, paste the whole of `voice-server/worker.js`, and click **Deploy**.
6. Go back to the worker and open **Settings**.
   - **Bindings** › **Add** › **KV namespace**. Variable name: `USAGE`. Namespace: `remagery-usage`. Save.
   - **Variables and Secrets** › **Add**:
     - Type **Secret**, name `GOOGLE_KEY`, value: your Google key from step 2.
     - Type **Text**, name `ALLOWED_ORIGIN`, value: your GitHub address without the `/remagery/` part, for example `https://yourname.github.io`.
   - Click **Deploy** to save.
7. Copy the worker's address. It looks like `https://remagery-voice.yourname.workers.dev`.

## 4. Connect the app to the voice server

Send the worker's address to Claude. You'll get back a new `js/config.js`.
Upload it to the `js` folder on GitHub (open the folder › **Add file** › **Upload files** › **Commit changes**).

After a minute, open Remagery on your phone. In **Aa** › **Voice**, you'll see the Google voices and how much of the free allowance has been used this month.

---

## Good to know

- **Making a book** happens on your phone. Keep Remagery open on screen while it works (about a minute).
- **The voice** for a chapter is made online the first time you play it (a few seconds), then kept on the phone. The next chapter is made while you listen, so it plays straight on with the phone locked.
- **Friends** use your voice allowance. A book is roughly half a million characters, so the free allowance covers about 7 books a month for everyone together. Settings shows how much is used.
- **Books stay on each phone.** Add Remagery to your Home Screen so iOS keeps them safe.
- **Copyright:** each person adds their own PDFs. No books are shared or uploaded anywhere.
