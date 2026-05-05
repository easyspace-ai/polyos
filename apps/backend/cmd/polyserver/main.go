package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/drinkthere/polyserver/internal/config"
	"github.com/drinkthere/polyserver/internal/httpapi"
	"github.com/drinkthere/polyserver/internal/logging"
	"github.com/sirupsen/logrus"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := config.FromEnv()
	logFile, err := logging.Setup(cfg.DataDir)
	if err != nil {
		logrus.WithError(err).Warn("log file setup failed; using stdout only")
	}
	if logFile != nil {
		defer logFile.Close()
	}

	app, err := httpapi.NewApp(ctx, cfg)
	if err != nil {
		logrus.WithError(err).Error("load app")
		os.Exit(1)
	}
	go func() {
		if err := app.PriceFeed.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logrus.WithError(err).Warn("price feed stopped")
		}
	}()
	go app.RunCloseQueue(ctx)
	go app.RunUserFeed(ctx)
	go app.RunChainSync(ctx)
	go app.RunHomeMarketsRefresh(ctx)

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           app.Router(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logrus.WithError(err).Warn("server shutdown")
		}
	}()

	logrus.WithFields(logrus.Fields{
		"addr":     addr,
		"data_dir": cfg.DataDir,
		"web_dir":  cfg.WebDir,
	}).Info("polyserver listening")
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logrus.WithError(err).Error("server failed")
		os.Exit(1)
	}
}
