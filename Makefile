SHELL := /bin/bash

ROOT_DIR := $(abspath .)
FRONTEND_DIR := $(ROOT_DIR)/apps/frontend
BACKEND_DIR := $(ROOT_DIR)/apps/backend
ELECTRON_DIR := $(ROOT_DIR)/apps/electron

FRONTEND_DIST_DIR := $(FRONTEND_DIR)/dist
BACKEND_EMBED_DIR := $(BACKEND_DIR)/internal/delivery/httpserver/web/dist
BACKEND_BIN_DIR := $(BACKEND_DIR)/bin
ELECTRON_BACKEND_RES_DIR := $(ELECTRON_DIR)/resources/backend
ELECTRON_BACKEND_WEB_DIR := $(ELECTRON_BACKEND_RES_DIR)/web
RUST_RELEASE_BIN := $(BACKEND_DIR)/target/release/polybackend

# Align with Node `process.platform` / `process.arch` (see apps/electron/src/main/index.ts).
UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_S),Darwin)
NODE_PLATFORM := darwin
else
NODE_PLATFORM := linux
endif
ifeq ($(UNAME_M),x86_64)
NODE_ARCH := x64
else ifeq ($(UNAME_M),aarch64)
NODE_ARCH := arm64
else
NODE_ARCH := $(UNAME_M)
endif

HOST_BACKEND_BIN := $(BACKEND_BIN_DIR)/server-$(NODE_PLATFORM)-$(NODE_ARCH)
MAC_ARM64_BACKEND_BIN := $(BACKEND_BIN_DIR)/server-darwin-arm64
WIN_X64_BACKEND_BIN := $(BACKEND_BIN_DIR)/server-win32-x64.exe

.PHONY: dev build dist-mac dist-win clean \
	frontend-build sync-frontend-embed \
	backend-build-host backend-build-mac-arm64 backend-build-win-x64 \
	prepare-electron-backend-host prepare-electron-backend-mac prepare-electron-backend-win \
	polybackend polybackend-build

# Rust API server: POLYBACKEND_DATA_DIR, POLYBACKEND_HOST, POLYBACKEND_PORT or PORT,
# POLYMARKET_PRIVATE_KEY (or per-account keys in derived-credentials.json), CLOB_API_URL.
polybackend:
	cd "$(BACKEND_DIR)" && cargo run --bin polybackend

polybackend-build:
	cd "$(BACKEND_DIR)" && cargo build --release --bin polybackend

dev: frontend-build sync-frontend-embed backend-build-host
	BACKEND_EXECUTABLE="$(HOST_BACKEND_BIN)" BACKEND_PORT="16666" PORT="16666" POLYBACKEND_PORT="16666" BACKEND_URL="http://127.0.0.1:16666" bun run electron:start

build: frontend-build sync-frontend-embed backend-build-host prepare-electron-backend-host
	bun run electron:build

dist-mac: frontend-build sync-frontend-embed backend-build-mac-arm64 prepare-electron-backend-mac
	bun run electron:dist:mac

dist-win: frontend-build sync-frontend-embed backend-build-win-x64 prepare-electron-backend-win
	bun run electron:dist:win

frontend-build:
	cd "$(FRONTEND_DIR)" && npm run build

sync-frontend-embed:
	mkdir -p "$(BACKEND_EMBED_DIR)"
	rm -rf "$(BACKEND_EMBED_DIR)"/*
	cp -R "$(FRONTEND_DIST_DIR)/client"/. "$(BACKEND_EMBED_DIR)/"
	mkdir -p "$(ELECTRON_BACKEND_WEB_DIR)"
	rm -rf "$(ELECTRON_BACKEND_WEB_DIR)"/*
	cp -R "$(FRONTEND_DIST_DIR)/client"/. "$(ELECTRON_BACKEND_WEB_DIR)/"

backend-build-host:
	mkdir -p "$(BACKEND_BIN_DIR)"
	cd "$(BACKEND_DIR)" && cargo build --release --bin polybackend
	cp -f "$(RUST_RELEASE_BIN)" "$(HOST_BACKEND_BIN)"
	chmod +x "$(HOST_BACKEND_BIN)" 2>/dev/null || true

backend-build-mac-arm64:
	mkdir -p "$(BACKEND_BIN_DIR)"
	cd "$(BACKEND_DIR)" && cargo build --release --bin polybackend --target aarch64-apple-darwin
	cp -f "$(BACKEND_DIR)/target/aarch64-apple-darwin/release/polybackend" "$(MAC_ARM64_BACKEND_BIN)"
	chmod +x "$(MAC_ARM64_BACKEND_BIN)"

backend-build-win-x64:
	mkdir -p "$(BACKEND_BIN_DIR)"
	cd "$(BACKEND_DIR)" && cargo build --release --bin polybackend --target x86_64-pc-windows-gnu
	cp -f "$(BACKEND_DIR)/target/x86_64-pc-windows-gnu/release/polybackend.exe" "$(WIN_X64_BACKEND_BIN)"

prepare-electron-backend-host:
	mkdir -p "$(ELECTRON_BACKEND_RES_DIR)"
	cp -f "$(HOST_BACKEND_BIN)" "$(ELECTRON_BACKEND_RES_DIR)/"

prepare-electron-backend-mac:
	mkdir -p "$(ELECTRON_BACKEND_RES_DIR)"
	cp -f "$(MAC_ARM64_BACKEND_BIN)" "$(ELECTRON_BACKEND_RES_DIR)/"

prepare-electron-backend-win:
	mkdir -p "$(ELECTRON_BACKEND_RES_DIR)"
	cp -f "$(WIN_X64_BACKEND_BIN)" "$(ELECTRON_BACKEND_RES_DIR)/"

clean:
	rm -rf "$(BACKEND_BIN_DIR)"
	rm -rf "$(BACKEND_DIR)/target"
	rm -rf "$(ELECTRON_BACKEND_RES_DIR)"
	rm -rf "$(ELECTRON_DIR)/dist"
	rm -rf "$(ELECTRON_DIR)/release"
