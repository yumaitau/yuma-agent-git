# Git over SSH gateway (issue #34). Not built by CI or any script yet: where
# it runs is still open (docs/adr/0007-ssh-gateway.md). The host key and the
# gateway key come from the environment or a mounted secret, never the image.
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /ssh-gateway .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /ssh-gateway /ssh-gateway
EXPOSE 2222
ENTRYPOINT ["/ssh-gateway"]
