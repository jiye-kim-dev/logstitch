# logstitch 빌드·패키징
#
#   make            로컬 개발 빌드 — .bin/logstitch (호스트 플랫폼)
#   make bundle     파서를 단일 실행 파일로 번들 — dist/logstitch-parse
#   make release    배포용 zip — dist/logstitch-<버전>-<os>-<arch>.zip
#   make test       e2e 전체 (빌드·단위 테스트 포함)
#   make clean
#
# 버전은 git 태그에서 온다 (없으면 커밋 해시). 릴리스 전에 태그를 먼저 딴다:
#   git tag v1.1.0 && make release

VERSION   ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS   := -X main.version=$(VERSION)
# 배포 대상 플랫폼. 팀원 머신이 늘면 여기만 추가한다.
PLATFORMS := darwin-arm64 darwin-amd64 linux-amd64 linux-arm64

.PHONY: build bundle release test clean

build:
	mkdir -p .bin
	go build -C collector -ldflags '$(LDFLAGS)' -o ../.bin/logstitch .

# 파서 번들: Node 22 대상 단일 파일. CJS 로 뽑는 이유 — 확장자 없는
# 실행 파일(~/.local/bin/logstitch-parse)을 node 가 CJS 로 해석하기 때문.
# 소스는 import.meta 를 쓰지 않으므로 (feature/xdg-paths) 변환이 안전하다.
# shebang 은 cli.ts 첫 줄의 것을 esbuild 가 그대로 보존한다 — banner 로 또 얹으면 중복.
bundle:
	mkdir -p dist
	cd parser && npx esbuild src/cli.ts --bundle --platform=node --target=node22 \
		--format=cjs --outfile=../dist/logstitch-parse
	chmod +x dist/logstitch-parse

release: bundle
	@for p in $(PLATFORMS); do \
		mkdir -p dist/$$p; \
		echo "== $$p =="; \
		GOOS=$${p%-*} GOARCH=$${p#*-} CGO_ENABLED=0 \
			go build -C collector -ldflags '$(LDFLAGS)' -o ../dist/$$p/logstitch . || exit 1; \
		cp dist/logstitch-parse dist/$$p/; \
		(cd dist/$$p && zip -q ../logstitch-$(VERSION)-$$p.zip logstitch logstitch-parse) || exit 1; \
	done
	@ls -lh dist/*.zip

test:
	./test/e2e.sh

clean:
	rm -rf .bin dist
