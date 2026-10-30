# Push the V2 branch from Termux

This workflow imports the supplied Git bundle into a separate local folder. It does not overwrite an existing V1 checkout.

1. Download `nodebase-v2-foundation.bundle` from the ChatGPT attachment and keep it in Android's `Downloads` folder.
2. In Termux, grant storage access and install Git:

```bash
termux-setup-storage
pkg update -y
pkg install -y git
```

3. Import the bundle and switch to the V2 branch:

```bash
cd ~/storage/downloads
ls -lh nodebase-v2-foundation.bundle

git clone --branch feat/nodebase-v2-foundation \
  ./nodebase-v2-foundation.bundle \
  ~/nodebase-v2-push

cd ~/nodebase-v2-push
git status --short --branch
```

4. Point the clone at the GitHub repository and push only the V2 branch:

```bash
git remote set-url origin https://github.com/vishwakesh/nodebase.git
git push -u origin feat/nodebase-v2-foundation
```

GitHub may prompt for authentication. For HTTPS, use your GitHub username and a GitHub Personal Access Token as the password; never paste the token into chat or commit it to a file. If SSH authentication is already configured in Termux, use `git@github.com:vishwakesh/nodebase.git` as the remote URL instead.

This pushes a feature branch only. It does not modify `main`, deploy to the VPS, or change the existing NODEBASE V1 deployment. Review the branch and CI results on GitHub before merging or deploying.
