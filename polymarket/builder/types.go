package builder

type GetBuilderTradesRequest struct {
	Limit   int
	Cursor  string
	StartDate string
	EndDate   string
}

type BuilderTrade struct {
	TradeID        string `json:"tradeId"`
	OrderID        string `json:"orderId"`
	BuilderAddress string `json:"builderAddress"`
	UserAddress    string `json:"userAddress"`
	ConditionID    string `json:"conditionId"`
	TokenID        string `json:"tokenID"`
	Side           string `json:"side"`
	Size           string `json:"size"`
	Price          string `json:"price"`
	Fee            string `json:"fee"`
	Rebate         string `json:"rebate"`
	Timestamp      int64  `json:"timestamp"`
}

type RebateRate struct {
	Tier          int    `json:"tier"`
	MinVolume     string `json:"minVolume"`
	MakerRebate   string `json:"makerRebate"`
	ReferralShare string `json:"referralShare"`
}