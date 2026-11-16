package connector

import "context"

func (c *MyDBConnector) AuthorizeToken(ctx context.Context, username string, token []byte) bool {
	return false
}
