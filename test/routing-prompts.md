# Routing test set (Phase 4)

Run each prompt in a new ChatGPT chat, Chat mode, outside any project, without mentioning the plugin.
D = should start a task on the Mac. C = should be answered in chat with no task. Gate: 19 of 20 right.
Half the set is borderline on purpose (the same job pasted vs on disk, a snippet to copy vs to run).

| # | Expect | Prompt |
|---|---|---|
| 1 | D | What's in my Downloads folder? Just list the 10 newest files. |
| 2 | D | Make me a tiny countdown timer web page and save it in a folder called p4-timer. |
| 3 | D | Check how much free disk space my Mac has. |
| 4 | D | Run node --version and python3 --version on my machine and tell me the output. |
| 5 | D | In ~/GPTWork/pomodoro, change the default break length to 10 minutes. |
| 6 | D | Add an MIT LICENSE file to the project in ~/GPTWork/pomodoro. |
| 7 | D | Open news.ycombinator.com in my browser and tell me the top story. |
| 8 | D | Fix this and save it as add.py in a folder called p4-fix: def add(a,b) return a+b |
| 9 | D | Convert this CSV to JSON and save it as data.json in a folder called p4-csv: name,age / Ana,30 / Bo,25 |
| 10 | D | Is port 3210 in use on my Mac, and by what process? |
| 11 | C | Fix this snippet: def add(a,b) return a+b |
| 12 | C | Draft a README for a small Pomodoro timer web app. |
| 13 | C | What's the difference between Postgres and SQLite for a side project? |
| 14 | C | Write a regex that matches a UK postcode. |
| 15 | C | Review this code: function f(x){ return x == null ? 0 : x.length } |
| 16 | C | Explain what launchd is on macOS. |
| 17 | C | Give me a bash one-liner to find the 10 largest files in a folder. |
| 18 | C | Plan the steps to migrate an Express app to Fastify. |
| 19 | C | What is the latest stable Node.js version? |
| 20 | C | Write a short email to my landlord asking them to fix the heating. |
