package rewards

type EarningsResponse struct {
	Date          string  `json:"date"`
	User          string  `json:"user"`
	TotalEarnings string  `json:"totalEarnings"`
	Fees          string  `json:"fees"`
	MakerRebate   string  `json:"makerRebate"`
	ReferralEarnings string `json:"referralEarnings"`
	Breakdown     []EarningsBreakdown `json:"breakdown"`
}

type EarningsBreakdown struct {
	Market      string `json:"market"`
	ConditionID string `json:"conditionId"`
	TokenID     string `json:"tokenId"`
	Volume      string `json:"volume"`
	Fees        string `json:"fees"`
	Earnings    string `json:"earnings"`
}

type RewardPercentage struct {
	Tier      int     `json:"tier"`
	MinVolume string  `json:"minVolume"`
	Rebate    float64 `json:"rebate"`
}

type Campaign struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	StartDate   int64  `json:"startDate"`
	EndDate     int64  `json:"endDate"`
	Active      bool   `json:"active"`
	Tiers       []CampaignTier `json:"tiers"`
}

type CampaignTier struct {
	Tier        int    `json:"tier"`
	MinVolume   string `json:"minVolume"`
	RewardRate  string `json:"rewardRate"`
}

type MarketReward struct {
	ConditionID string `json:"conditionId"`
	RewardRate  string `json:"rewardRate"`
	CampaignID  string `json:"campaignId"`
}

type BuilderFeeRate struct {
	FeeRate string `json:"feeRate"`
}