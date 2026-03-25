.PHONY: build run clean

build:
	cd server && go build -o ../bin/relay ./cmd/relay

run: build
	./bin/relay -config config.yaml

clean:
	rm -rf bin/
