package orderbuilder

import (
	"context"
	"encoding/json"
	"math/big"
	"strings"

	polyauth "github.com/drinkthere/polymarket-sdk/polymarket/auth"
	polyerrors "github.com/drinkthere/polymarket-sdk/polymarket/errors"
	"github.com/drinkthere/polymarket-sdk/polymarket/markets"
	"github.com/drinkthere/polymarket-sdk/polymarket/orders"
	"github.com/drinkthere/polymarket-sdk/polymarket/httpx"
)

type Client struct {
	ordersClient  *orders.Client
	marketsClient *markets.Client
	signer        *polyauth.Signer
}

func New(httpClient *httpx.Client, authConfig polyauth.Config) (*Client, error) {
	ordersClient, err := orders.NewClient(httpClient, authConfig)
	if err != nil {
		return nil, err
	}

	marketsClient, err := markets.NewClient(httpClient)
	if err != nil {
		return nil, err
	}

	signer, err := polyauth.NewSigner(authConfig)
	if err != nil {
		return nil, err
	}

	return &Client{
		ordersClient:  ordersClient,
		marketsClient: marketsClient,
		signer:        signer,
	}, nil
}

type OrderArgsV2 struct {
	TokenID string
	Price   string
	Size    string
	Side    Side
}

type MarketOrderArgsV2 struct {
	TokenID string
	Price   string
	Amount  string
	Side    Side
}

type Side string

const (
	Buy  Side = "BUY"
	Sell Side = "SELL"
)

type OrderType string

const (
	GTC OrderType = "GTC"
	GTD OrderType = "GTD"
	FOK OrderType = "FOK"
	FAK OrderType = "FAK"
)

type CreateOrderOptions struct {
	TickSize string
	NegRisk  bool
}

type OrderResponse struct {
	OrderID string `json:"orderID"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

func (c *Client) BuildOrder(ctx context.Context, args OrderArgsV2, opts CreateOrderOptions) (orders.MakerOrder, error) {
	if args.TokenID == "" {
		return orders.MakerOrder{}, &polyerrors.Error{
			Kind:    polyerrors.ErrRequestBuild,
			Op:      "orderbuilder.build",
			Message: "token_id is required",
		}
	}
	if args.Price == "" {
		return orders.MakerOrder{}, &polyerrors.Error{
			Kind:    polyerrors.ErrRequestBuild,
			Op:      "orderbuilder.build",
			Message: "price is required",
		}
	}
	if args.Size == "" {
		return orders.MakerOrder{}, &polyerrors.Error{
			Kind:    polyerrors.ErrRequestBuild,
			Op:      "orderbuilder.build",
			Message: "size is required",
		}
	}

	tickSize := opts.TickSize
	negRisk := opts.NegRisk

	if tickSize == "" {
		info, err := c.marketsClient.GetClobMarketInfo(ctx, args.TokenID)
		if err != nil {
			return orders.MakerOrder{}, err
		}
		tickSize = info.TickSize
		negRisk = info.NegRisk
	}

	price, err := validatePrice(args.Price, tickSize)
	if err != nil {
		return orders.MakerOrder{}, err
	}

	order := orders.MakerOrder{
		TokenID: args.TokenID,
		Price:   price,
		Size:    args.Size,
		Side:    strings.ToUpper(string(args.Side)),
	}

	return order, nil
}

func (c *Client) BuildOrderForToken(ctx context.Context, args OrderArgsV2) (orders.MakerOrder, error) {
	return c.BuildOrder(ctx, args, CreateOrderOptions{})
}

func (c *Client) BuildMarketOrder(ctx context.Context, args MarketOrderArgsV2, opts CreateOrderOptions) (orders.MakerOrder, error) {
	if args.TokenID == "" {
		return orders.MakerOrder{}, &polyerrors.Error{
			Kind:    polyerrors.ErrRequestBuild,
			Op:      "orderbuilder.build_market",
			Message: "token_id is required",
		}
	}
	if args.Amount == "" {
		return orders.MakerOrder{}, &polyerrors.Error{
			Kind:    polyerrors.ErrRequestBuild,
			Op:      "orderbuilder.build_market",
			Message: "amount is required",
		}
	}

	tickSize := opts.TickSize
	negRisk := opts.NegRisk

	if tickSize == "" {
		info, err := c.marketsClient.GetClobMarketInfo(ctx, args.TokenID)
		if err != nil {
			return orders.MakerOrder{}, err
		}
		tickSize = info.TickSize
		negRisk = info.NegRisk
	}

	price, err := validatePrice(args.Price, tickSize)
	if err != nil {
		return orders.MakerOrder{}, err
	}

	order := orders.MakerOrder{
		TokenID: args.TokenID,
		Price:   price,
		Size:    args.Amount,
		Side:    strings.ToUpper(string(args.Side)),
	}

	return order, nil
}

func (c *Client) BuildMarketOrderForToken(ctx context.Context, args MarketOrderArgsV2) (orders.MakerOrder, error) {
	return c.BuildMarketOrder(ctx, args, CreateOrderOptions{})
}

func (c *Client) CreateAndPostOrder(ctx context.Context, args OrderArgsV2, opts CreateOrderOptions, orderType OrderType, credentials *polyauth.APICredentials) (OrderResponse, error) {
	order, err := c.BuildOrder(ctx, args, opts)
	if err != nil {
		return OrderResponse{}, err
	}

	var creds polyauth.APICredentials
	if credentials != nil {
		creds = *credentials
	}

	orderTypeStr := string(orderType)
	if orderType == "" {
		orderTypeStr = string(GTC)
	}

	resp, err := c.ordersClient.PlaceMakerOrder(ctx, orders.PlaceMakerOrderRequest{
		Order:     order,
		OrderType: orders.OrderType(orderTypeStr),
		DeferExec: orderType == GTC || orderType == GTD,
		PostOnly:  orderType == GTC || orderType == GTD,
		Credentials: creds,
	})
	if err != nil {
		return OrderResponse{}, err
	}

	return OrderResponse{
		OrderID: resp.OrderID,
		Success: resp.Success,
		Error:   resp.Error,
	}, nil
}

func (c *Client) CreateAndPostOrderForToken(ctx context.Context, args OrderArgsV2, orderType OrderType, credentials *polyauth.APICredentials) (OrderResponse, error) {
	return c.CreateAndPostOrder(ctx, args, CreateOrderOptions{}, orderType, credentials)
}

func (c *Client) CreateAndPostMarketOrder(ctx context.Context, args MarketOrderArgsV2, orderType OrderType, credentials *polyauth.APICredentials) (OrderResponse, error) {
	order, err := c.BuildMarketOrder(ctx, args, CreateOrderOptions{})
	if err != nil {
		return OrderResponse{}, err
	}

	var creds polyauth.APICredentials
	if credentials != nil {
		creds = *credentials
	}

	orderTypeStr := string(orderType)
	if orderType == "" {
		orderTypeStr = string(FOK)
	}

	resp, err := c.ordersClient.PlaceMakerOrder(ctx, orders.PlaceMakerOrderRequest{
		Order:     order,
		OrderType: orders.OrderType(orderTypeStr),
		PostOnly:  false,
		DeferExec: false,
		Credentials: creds,
	})
	if err != nil {
		return OrderResponse{}, err
	}

	return OrderResponse{
		OrderID: resp.OrderID,
		Success: resp.Success,
		Error:   resp.Error,
	}, nil
}

func (c *Client) CreateAndPostMarketOrderForToken(ctx context.Context, args MarketOrderArgsV2, orderType OrderType, credentials *polyauth.APICredentials) (OrderResponse, error) {
	return c.CreateAndPostMarketOrder(ctx, args, orderType, credentials)
}

func validatePrice(price, tickSize string) (string, error) {
	if tickSize == "" {
		return price, nil
	}

	priceFloat := new(big.Float)
	_, _, err := priceFloat.Parse(price, 10)
	if err != nil {
		return "", &polyerrors.Error{
			Kind:    polyerrors.ErrRequestBuild,
			Op:      "orderbuilder.validate_price",
			Message: "invalid price format",
			Cause:   err,
		}
	}

	tickFloat := new(big.Float)
	_, _, err = tickFloat.Parse(tickSize, 10)
	if err != nil {
		return price, nil
	}

	quotient := new(big.Float).Quo(priceFloat, tickFloat)
	intPart, accuracy := quotient.Uint64()
	if accuracy == big.Below {
		return "", &polyerrors.Error{
			Kind:    polyerrors.ErrRequestBuild,
			Op:      "orderbuilder.validate_price",
			Message: "price must be a multiple of tick_size",
		}
	}

	rounded := new(big.Float).Mul(tickFloat, new(big.Float).SetUint64(intPart))
	return rounded.Text('f', -1), nil
}