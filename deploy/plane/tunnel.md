# Plane Cloudflared Tunnel

Plane is served locally on `loom-desk` at:

```sh
http://localhost:8750
```

It was exposed through the existing Cloudflare Tunnel using this repo's deploy CLI:

```sh
bun src/cli/beckett.ts deploy plane --port 8750
```

That command wires the service into `~/.cloudflared/config.yml` with an ingress rule equivalent to:

```yaml
ingress:
  - hostname: plane.0xbeckett.me
    service: http://localhost:8750
  - service: http_status:404
```

Verify the public route from any machine with network access:

```sh
curl -I https://plane.0xbeckett.me/
```

Expected result: an HTTP response from Plane through Cloudflare. TLS terminates at Cloudflare, so Plane's local HTTPS listener is not used for this route.
