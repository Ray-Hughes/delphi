# Delphi
#
# Two processes make up a running system: the app itself, and Ollama serving the
# local embedding model. `make start` brings up both; `make stop` takes both
# down. Everything else is a smaller version of those two.
#
# Targets are safe to repeat. Starting something already running says so and does
# nothing, rather than launching a second copy.

SHELL := /bin/bash
.DEFAULT_GOAL := help

APP_DIR   := $(shell cd "$(dir $(lastword $(MAKEFILE_LIST)))" && pwd)
APP_MATCH := $(APP_DIR)/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
APP_LOG   := /tmp/delphi.log
OLLAMA_LOG:= /tmp/delphi-ollama.log
OLLAMA_URL:= http://127.0.0.1:11434
MODEL     := nomic-embed-text

# Where the database and the Sheet run logs live. From a checkout that is the
# checkout itself, as paths.js decides. Point it at an installed app's data with
# DELPHI_DATA_DIR="$HOME/Library/Application Support/Delphi" make prune-logs.
DATA_DIR  := $(or $(DELPHI_DATA_DIR),$(APP_DIR))
PRUNE_DAYS:= 30

# Resolved rather than assumed: an editor or launcher may run make without the
# PATH a terminal has.
NODE := $(shell command -v node 2>/dev/null || echo /usr/local/bin/node)

green := \033[32m
dim   := \033[2m
bold  := \033[1m
off   := \033[0m

.PHONY: help start stop restart status app app-stop app-restart model model-stop \
        reindex rebuild logs applogs modellogs doctor install backup setup desktop mcp \
        icons dist test cli prune-logs

help: ## Show this help
	@echo ""
	@echo -e "$(bold)Delphi$(off)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(green)%-14s$(off) %s\n", $$1, $$2}'
	@echo ""
	@echo -e "  $(dim)make start   brings up the model and the app$(off)"
	@echo -e "  $(dim)make stop    takes both down$(off)"
	@echo ""

# --- everything -------------------------------------------------------------

start: model app ## Start everything: the local model, then the app
	@echo -e "$(green)Delphi is up.$(off) Press your shortcut, or find it in the dock."

stop: app-stop model-stop ## Stop everything
	@echo -e "$(green)Delphi is down.$(off)"

restart: stop ## Restart everything
	@sleep 1
	@$(MAKE) --no-print-directory start

status: ## What is running
	@echo ""
	@printf "  %-22s" "App"
	@if pgrep -f "$(APP_MATCH)" >/dev/null 2>&1; then \
	  echo -e "$(green)running$(off) (pid $$(pgrep -f "$(APP_MATCH)" | head -1))"; \
	else echo -e "$(dim)stopped$(off)"; fi
	@printf "  %-22s" "Embedding model"
	@if curl -s --max-time 2 $(OLLAMA_URL)/api/version >/dev/null 2>&1; then \
	  echo -e "$(green)running$(off) ($$(curl -s --max-time 2 $(OLLAMA_URL)/api/version | sed 's/[{}\"]//g'))"; \
	else echo -e "$(dim)stopped$(off)  embeddings fall back to lexical"; fi
	@printf "  %-22s" "Model pulled"
	@if ollama list 2>/dev/null | grep -q "$(MODEL)"; then echo -e "$(green)$(MODEL)$(off)"; \
	  else echo -e "$(dim)missing$(off)  run: ollama pull $(MODEL)"; fi
	@printf "  %-22s" "Indexed"
	@sqlite3 "$(APP_DIR)/delphi.db" "SELECT COUNT(*)||' vectors, '||(SELECT COUNT(*) FROM entities)||' entities, '||(SELECT COUNT(*) FROM edges)||' edges' FROM embeddings;" 2>/dev/null || echo "database not readable"
	@printf "  %-22s" "Open work"
	@sqlite3 "$(APP_DIR)/delphi.db" "SELECT COUNT(*)||' tasks, '||(SELECT COUNT(*) FROM notes)||' notes' FROM tasks WHERE status != 'done';" 2>/dev/null || true
	@echo ""

# --- the app ----------------------------------------------------------------

app: ## Start just the app
	@if pgrep -f "$(APP_MATCH)" >/dev/null 2>&1; then \
	  echo "  app already running"; \
	else \
	  cd "$(APP_DIR)" && nohup npm start < /dev/null > $(APP_LOG) 2>&1 & disown; \
	  sleep 4; \
	  if pgrep -f "$(APP_MATCH)" >/dev/null 2>&1; then echo -e "  app $(green)started$(off)"; \
	  else echo "  app failed to start, see $(APP_LOG)"; tail -5 $(APP_LOG); fi; \
	fi

app-stop: ## Stop just the app
	@if pgrep -f "$(APP_MATCH)" >/dev/null 2>&1; then \
	  pkill -f "$(APP_MATCH)" 2>/dev/null || true; \
	  for i in 1 2 3 4 5 6 7 8 9 10; do \
	    pgrep -f "$(APP_MATCH)" >/dev/null 2>&1 || break; sleep 0.4; \
	  done; \
	  if pgrep -f "$(APP_MATCH)" >/dev/null 2>&1; then \
	    pkill -9 -f "$(APP_MATCH)" 2>/dev/null || true; sleep 1; fi; \
	  echo "  app stopped"; \
	else echo "  app was not running"; fi

app-restart: app-stop app ## Restart just the app

# --- the model ---------------------------------------------------------------

model: ## Start the local embedding model
	@if curl -s --max-time 2 $(OLLAMA_URL)/api/version >/dev/null 2>&1; then \
	  echo "  model already serving"; \
	else \
	  if ! command -v ollama >/dev/null 2>&1; then \
	    echo "  ollama is not installed. Run: brew install ollama"; exit 1; fi; \
	  nohup ollama serve < /dev/null > $(OLLAMA_LOG) 2>&1 & disown; \
	  for i in 1 2 3 4 5 6 7 8; do \
	    sleep 1; \
	    if curl -s --max-time 2 $(OLLAMA_URL)/api/version >/dev/null 2>&1; then break; fi; \
	  done; \
	  if curl -s --max-time 2 $(OLLAMA_URL)/api/version >/dev/null 2>&1; then \
	    echo -e "  model $(green)serving$(off)"; \
	  else echo "  model failed to start, see $(OLLAMA_LOG)"; fi; \
	fi
	@if ! ollama list 2>/dev/null | grep -q "$(MODEL)"; then \
	  echo "  pulling $(MODEL), this happens once"; ollama pull $(MODEL); fi

model-stop: ## Stop the local embedding model
	@if pgrep -f "ollama serve" >/dev/null 2>&1; then \
	  pkill -f "ollama serve" 2>/dev/null || true; echo "  model stopped"; \
	else echo "  model was not running"; fi

# --- the index ---------------------------------------------------------------

reindex: ## Re-embed everything, after a model change
	@cd "$(APP_DIR)" && npx electron -e "\
	const {DatabaseSync}=require('node:sqlite');\
	const e=require('$(APP_DIR)/embeddings.js');\
	const db=new DatabaseSync('$(APP_DIR)/delphi.db');\
	e.reindex(db,{force:true}).then(r=>{console.log('  '+JSON.stringify(r));process.exit(0)});" 2>/dev/null \
	  | grep -v Warning || true

rebuild: ## Rebuild the knowledge graph from the notes and tasks
	@cd "$(APP_DIR)" && npx electron -e "\
	const {DatabaseSync}=require('node:sqlite');\
	const o=require('$(APP_DIR)/oracle.js');\
	const db=new DatabaseSync('$(APP_DIR)/delphi.db');\
	console.log('  '+JSON.stringify(o.rebuild(db)));process.exit(0);" 2>/dev/null \
	  | grep -v Warning || true

# --- housekeeping ------------------------------------------------------------

logs: ## Follow the app log
	@tail -f $(APP_LOG)

modellogs: ## Follow the model log
	@tail -f $(OLLAMA_LOG)

install: ## Install dependencies
	@cd "$(APP_DIR)" && npm install
	@command -v ollama >/dev/null 2>&1 || echo "  ollama not installed. For local embeddings: brew install ollama"

icons: ## Rebuild every icon from the artwork in build/source
	@python3 "$(APP_DIR)/tools/make_icons.py"

# --config, always. electron-builder looks for electron-builder.yml by default,
# and without the flag it quietly builds from defaults that ship everything not
# ignored, the database and the vault included.
dist: ## Build the installer for this platform, into release/
	@cd "$(APP_DIR)" && npx electron-builder --config electron-builder.config.js
	@echo ""
	@ls -lh "$(APP_DIR)/release"/*.dmg "$(APP_DIR)/release"/*.exe 2>/dev/null || true
	@echo ""
	@echo -e "  $(dim)Windows installers are built by the release workflow, not here:$(off)"
	@echo -e "  $(dim)building one on a Mac needs Wine.$(off)"

test: ## Run every test, as CI does
	@cd "$(APP_DIR)" && npm test

# ~/.local/bin first when it is already on PATH: it is per user, needs no sudo,
# and is where pip, pipx and most installers put things. Otherwise
# /usr/local/bin when it is writable, because a stock macOS shell has it on PATH
# and ~/.local/bin is not. A symlink rather than a copy, so a git pull updates the
# command with no reinstall. An existing file that is not a symlink is left
# alone: that is somebody else's delphi.
cli: ## Put the delphi command on your PATH
	@src="$(APP_DIR)/bin/delphi"; \
	if [ ! -f "$$src" ]; then echo "  bin/delphi does not exist yet in this checkout"; exit 1; fi; \
	chmod +x "$$src"; \
	if [[ ":$$PATH:" == *":$$HOME/.local/bin:"* ]]; then dir="$$HOME/.local/bin"; \
	elif [ -w /usr/local/bin ]; then dir=/usr/local/bin; \
	else dir="$$HOME/.local/bin"; fi; \
	mkdir -p "$$dir"; \
	if [ -e "$$dir/delphi" ] && [ ! -L "$$dir/delphi" ]; then \
	  echo "  $$dir/delphi exists and is not a link this made. Left alone."; exit 1; fi; \
	ln -sfn "$$src" "$$dir/delphi"; \
	echo -e "  linked $(green)$$dir/delphi$(off) -> $$src"; \
	if [[ ":$$PATH:" != *":$$dir:"* ]]; then \
	  echo -e "  $(dim)$$dir is not on your PATH. Add this to your shell profile:$(off)"; \
	  echo "    export PATH=\"$$dir:\$$PATH\""; fi

# Run logs are kept until their task is deleted, and this is the other way out:
# tasks done more than PRUNE_DAYS ago. The database is opened read only through
# the sqlite3 binary, so this can run while the app is open and can never write
# to it. Nothing is deleted when the database cannot be read, and a database with
# no tasks at all is taken as the wrong database rather than as every task having
# been deleted. DRY=1 lists what would go.
prune-logs: ## Delete Sheet run logs for tasks done over 30 days ago, or deleted
	@logs="$(DATA_DIR)/sheets"; db="$${DELPHI_DB:-$(DATA_DIR)/delphi.db}"; \
	if [ ! -d "$$logs" ]; then echo "  no run logs at $$logs"; exit 0; fi; \
	if [ ! -f "$$db" ]; then echo "  no database at $$db, nothing pruned"; exit 1; fi; \
	total=$$(sqlite3 -readonly "$$db" "SELECT COUNT(*) FROM tasks;" 2>&1) \
	  || { echo "  could not read $$db: $$total. Nothing pruned."; exit 1; }; \
	if [ "$$total" = 0 ]; then echo "  $$db has no tasks, so it is not the one these logs belong to. Nothing pruned."; exit 1; fi; \
	keep=$$(sqlite3 -readonly "$$db" "SELECT id FROM tasks WHERE NOT (status = 'done' \
	  AND COALESCE(completed_at, updated_at) < datetime('now', '-$(PRUNE_DAYS) days'));" 2>&1) \
	  || { echo "  could not read $$db: $$keep. Nothing pruned."; exit 1; }; \
	n=0; \
	for d in "$$logs"/*/; do \
	  id=$$(basename "$$d"); [[ "$$id" =~ ^[0-9]+$$ ]] || continue; \
	  grep -qx "$$id" <<<"$$keep" && continue; \
	  if [ -n "$(DRY)" ]; then echo "  would prune $$logs/$$id"; else rm -r -- "$$logs/$$id"; fi; \
	  n=$$((n + 1)); \
	done; \
	if [ -n "$(DRY)" ]; then echo "  $$n task log folders would be pruned"; \
	else echo "  pruned the logs of $$n tasks from $$logs"; fi

backup: ## Copy the database somewhere safe
	@mkdir -p "$(HOME)/backups"
	@cp "$(APP_DIR)/delphi.db" "$(HOME)/backups/delphi-$$(date +%F-%H%M).db"
	@echo "  saved to ~/backups/delphi-$$(date +%F-%H%M).db"

doctor: ## Check everything is wired up correctly
	@echo ""
	@printf "  %-26s" "node"; command -v node >/dev/null && node --version || echo "MISSING"
	@printf "  %-26s" "sqlite3"; command -v sqlite3 >/dev/null && sqlite3 --version | cut -d' ' -f1 || echo "MISSING"
	@printf "  %-26s" "ollama"; command -v ollama >/dev/null && ollama --version 2>/dev/null | head -1 || echo "not installed (optional)"
	@printf "  %-26s" "database"; [ -f "$(APP_DIR)/delphi.db" ] && echo "$$(du -h "$(APP_DIR)/delphi.db" | cut -f1)" || echo "MISSING"
	@printf "  %-26s" "MCP registered"; claude mcp list 2>/dev/null | grep -q delphi && echo "yes" || echo "no, run: make mcp"
	@echo ""

mcp: ## Connect the Oracle to Claude Code and Copilot
	@bash "$(APP_DIR)/install/mcp.sh"

desktop: ## Put a Delphi icon on the Desktop
	@bash "$(APP_DIR)/install/desktop.sh"

setup: install mcp desktop ## First run: dependencies, agents and Desktop icon
	@echo ""
	@echo -e "  $(green)ready$(off). Start it with: $(bold)make start$(off)"
	@echo -e "  $(dim)Restart your editor so it picks up the MCP server.$(off)"
	@echo ""
