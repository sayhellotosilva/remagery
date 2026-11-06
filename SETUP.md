# Remagery web app: setup

The app is online at **https://remagery.pages.dev** (Cloudflare Pages, updates by itself from GitHub). The old address https://sayhellotosilva.github.io/remagery/ still works.

Two more parts, about 30–40 minutes:

1. **Google Cloud** is for Google sign-in, Google Drive (your books and progress) and the voice.
2. **Cloudflare** runs the small voice server, which keeps your Google voice key secret and stops before the free limit.

---

## 1. Google Cloud

Go to **console.cloud.google.com** and sign in with your Google account.

### 1a. Make a project
1. Click the project menu at the top › **New project**. Name: `Remagery`. Click **Create**, then select it.

### 1b. Switch on three Google services
For each one: type its name in the search bar at the top, open it, and click **Enable**.
- **Google Drive API**
- **Google Picker API**
- **Cloud Text-to-Speech API**. Google asks for a billing account and a card here. Remagery's voice server stops at 3.8 million characters a month, below the free 4 million.

### 1c. The sign-in screen (Google Auth Platform)
1. Search for **Google Auth Platform** and click **Get started**.
2. App name: `Remagery`. Support email: your email. Click **Next**.
3. Audience: **External**. Click **Next**.
4. Contact email: your email. Click **Next**, tick to agree, then **Create**.
5. Open **Data access** › **Add or remove scopes**. Tick `.../auth/drive.file`, `openid` and `.../auth/userinfo.email`. Click **Update**, then **Save**.
6. Open **Audience** › **Publish app** › **Confirm**. Now friends can sign in too. These permissions don't need Google's review.

### 1d. The sign-in key (OAuth client)
1. In Google Auth Platform, open **Clients** › **Create client**.
2. Application type: **Web application**. Name: `Remagery web`.
3. Authorized JavaScript origins › **Add URI**: `https://sayhellotosilva.github.io`
4. Authorized redirect URIs › **Add URI**: `https://sayhellotosilva.github.io/remagery/`
5. Click **Create**. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`).

### 1e. Two API keys
Search for **Credentials**.

**Key 1: for choosing books in Drive**
1. **Create credentials** › **API key**. Open the new key (**Edit API key**).
2. Name: `Remagery picker`.
3. Application restrictions: **Websites** › add `https://sayhellotosilva.github.io/*`
4. API restrictions: **Restrict key** › tick only **Google Picker API**. Click **Save**. Copy the key.

**Key 2: for the voice (keep this one secret)**
1. **Create credentials** › **API key**. Open it.
2. Name: `Remagery voice`. API restrictions: **Restrict key** › tick only **Cloud Text-to-Speech API**. Click **Save**.
3. Copy it. It only goes into Cloudflare (step 2), never into the app.

### 1f. Project number
Click the project menu at the top. The **project number** is next to the project ID. Copy it.

**Send Claude:** the Client ID, the picker key (Key 1) and the project number. These three aren't secret. Claude puts them in `js/config.js`.

Optional: search for **Budgets & alerts** and make a budget of €1, so Google emails you if anything is ever charged.

---

## 2. The voice server (Cloudflare)

1. Go to **dash.cloudflare.com** and make a free account.
2. Left menu: **Storage & Databases** › **KV** › **Create**. Name: `remagery-usage`. Click **Add**.
3. Left menu: **Compute (Workers)** › **Workers & Pages** › **Create** › **Create Worker**. Name: `remagery-voice`. Click **Deploy**.
4. Click **Edit code**. Delete everything, paste the whole of `voice-server/worker.js`, and click **Deploy**.
5. Back on the worker, open **Settings**:
   - **Bindings** › **Add** › **KV namespace**. Variable name `USAGE`, namespace `remagery-usage`. Save.
   - **Variables and Secrets** › **Add**:
     - Type **Secret**, name `GOOGLE_KEY`, value: Key 2 from step 1e.
     - Type **Text**, name `ALLOWED_ORIGIN`, value `https://sayhellotosilva.github.io`
   - Click **Deploy**.
6. Copy the worker's address (like `https://remagery-voice.yourname.workers.dev`) and send it to Claude.

---

## Good to know

- **Your library lives in Google Drive.** Remagery makes a **Remagery** folder with one folder per book (text, images, cover) and a `library.json` with your progress and bookmarks. It can only see files you pick and files it makes.
- **The voice is saved to Drive too**, in the book's folder, once a chapter is made. On a new device it downloads from Drive instead of being made again, so it doesn't use the monthly voice allowance twice.
- **On a new phone or laptop:** sign in and your books appear with "In Drive" on them. Each one downloads when you open it.
- **Removing a book** moves its Drive folder to the bin. Your original PDF isn't touched.
- **Making a book** happens on your phone. Keep Remagery on screen while it works (about a minute).
- **Friends** sign in with their own Google account and get their own library. They share your voice allowance: about 7 books a month for everyone together.
