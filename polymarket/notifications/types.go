package notifications

type GetNotificationsRequest struct {
	Limit  int
	Cursor string
}

type Notification struct {
	ID        string      `json:"id"`
	Type      string      `json:"type"`
	Title     string      `json:"title"`
	Message   string      `json:"message"`
	Data      interface{} `json:"data,omitempty"`
	Read      bool        `json:"read"`
	CreatedAt int64       `json:"createdAt"`
}

type NotificationType string

const (
	NotificationTypeOrderFilled    NotificationType = "order_filled"
	NotificationTypeOrderCancelled NotificationType = "order_cancelled"
	NotificationTypePositionOpened NotificationType = "position_opened"
	NotificationTypeMarketResolved NotificationType = "market_resolved"
	NotificationTypePriceAlert     NotificationType = "price_alert"
	NotificationTypeLiquidation    NotificationType = "liquidation"
	NotificationTypeReward         NotificationType = "reward"
)