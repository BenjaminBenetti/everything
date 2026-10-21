// Command registry-check asks the local registry for its API root with Go's default HTTP client, as
// fleetd's registry client does, and exits nonzero unless the certificate is trusted and the
// registry answers 401, asking for credentials.
package main

import (
	"fmt"
	"net/http"
	"os"
	"time"
)

func main() {
	client := &http.Client{Timeout: 20 * time.Second}
	response, err := client.Get("https://" + os.Args[1] + "/v2/")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer response.Body.Close()
	fmt.Println(response.Status)
	if response.StatusCode != http.StatusUnauthorized {
		os.Exit(1)
	}
}
