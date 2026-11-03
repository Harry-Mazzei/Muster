# Setting up the web version

This takes about 15 minutes, once. You need a GitHub account and a Google account.
Replace `USERNAME` below with your GitHub username.

## 1. Put the code on GitHub

1. Install **GitHub Desktop** (desktop.github.com) and sign in to GitHub.
2. Choose **File → Add Local Repository**, then choose this `muster` folder.
   When it says it isn't a repository yet, click **create a repository**, then **Create Repository**.
3. Click **Publish repository**. Untick **Keep this code private** if you want it public, then click
   **Publish**.
4. On github.com, open the repository and go to **Settings → Pages**. Under *Build and deployment →
   Source*, choose **GitHub Actions**.
5. Open the **Actions** tab, click **Publish web version** and then **Run workflow**. When it goes green, the
   site is live at `https://USERNAME.github.io/muster/`. It shows "not connected to an account yet" until
   you finish step 2.

## 2. Create the sign-in (Firebase, free)

1. Go to console.firebase.google.com, click **Create a project** and name it `muster`.
   Google Analytics can be turned off.
2. Go to **Build → Authentication → Get started**. Under **Sign-in method**, choose **Google**, turn it
   on, pick your email as the support email, and click **Save**.
3. Still in Authentication, go to **Settings → Authorized domains → Add domain** and enter `USERNAME.github.io`.
   *Optional:* also turn on **Email/Password** under Sign-in method if you'd like to sign in with an email
   and password instead of Google. Muster sends a link to confirm the address the first time, and only a
   confirmed address is let in.
4. Go to **Build → Firestore Database → Create database**. Choose the location
   **australia-southeast1 (Sydney)** and **production mode**.
5. In Firestore, open the **Rules** tab, replace everything with the rules below and click **Publish**.
   Anyone can sign up, but each person can only see and change their own parades. Email accounts must
   confirm their address first.
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid}/{document=**} {
         allow read, write: if request.auth != null
           && request.auth.uid == uid
           && request.auth.token.email_verified == true;
       }
     }
   }
   ```
   To make it private to just you instead, add `&& request.auth.token.email == "you@gmail.com"` before the `;`.
6. Click the gear icon, then **Project settings → General → Your apps**. Click the **</>** (Web) icon,
   name the app `Muster`, leave Hosting unticked and click **Register app**.
   Copy the `firebaseConfig = { ... }` block it shows.
7. Open `server/web/firebase-config.js` and replace `null` with that block, so it looks like:
   ```js
   window.MUSTER_FIREBASE = {
     apiKey: "...",
     authDomain: "muster-xxxx.firebaseapp.com",
     projectId: "muster-xxxx",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "..."
   };
   ```
8. In GitHub Desktop, type a summary such as "Connect Firebase", click **Commit to main**, then
   **Push origin**. The site updates in about a minute.

These values are not secret, so it's fine that they're public. Google designs them to sit in web pages.
Security comes from the rules in step 5.

**Optional extra lock:** go to console.cloud.google.com, choose the `muster` project, then
**APIs & Services → Credentials** and the **Browser key**. Set *Application restrictions* to
*Websites* and add `https://USERNAME.github.io/*` and `https://muster-xxxx.firebaseapp.com/*`.

## 3. First use

1. Open `https://USERNAME.github.io/muster/` and click **Sign in with Google**.
2. **Bring your parades across:** in the laptop app, go to **Settings → Download backup**. In the web
   version, go to **Settings → Restore from backup** and choose that file. Your parades, beat points and
   settings come over, and they sync to every laptop you sign in on.
3. **Add the private music on each laptop:** go to **Music → Choose music folder** and pick your music folder.
   The music is copied into that browser only and never uploaded. Your own music in `tracks` doesn't
   need this step.

### Adding your own music to the site

Put the files in the `tracks` folder, then commit and push in GitHub Desktop. A minute later they appear on
every laptop with nothing to choose. Everything in `tracks` is public, so only add music you own or are
allowed to share. Never add the ADF recordings. See `tracks/README.md` for naming tips.

### Good to know

- Use **Chrome or Edge** for the web version where you can. Safari can clear a website's stored files
  if you don't open it for a few weeks. If tracks show as missing, press **Choose music folder** again.
  Parades are never lost, because they're in your account.
- Once it has been opened, the web version also works with no internet, which helps in parade halls.
- The laptop app keeps working exactly as before, with no sign-in and no internet.
