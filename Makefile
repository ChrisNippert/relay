.PHONY: build run clean release

build:
	cd server && go build -o ../bin/relay ./cmd/relay

run: build
	./bin/relay -config config.yaml

clean:
	rm -rf bin/ release/

release:
	@mkdir -p release
	cd server && GOOS=linux GOARCH=amd64 go build -o ../release/relay-linux-amd64 ./cmd/relay
	cd server && GOOS=windows GOARCH=amd64 go build -o ../release/relay-windows-amd64.exe ./cmd/relay
	cd server && GOOS=darwin GOARCH=amd64 go build -o ../release/relay-darwin-amd64 ./cmd/relay
	cd server && GOOS=darwin GOARCH=arm64 go build -o ../release/relay-darwin-arm64 ./cmd/relay
	@echo "Server binaries built in release/"

# Federation testing: two local nodes on ports 3002 and 3003
fed-a: build
	./bin/relay -config fed-test/node-a/config.yaml

fed-b: build
	./bin/relay -config fed-test/node-b/config.yaml
