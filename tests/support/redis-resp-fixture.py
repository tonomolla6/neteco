"""Bounded loopback-only RESP server for the real ioredis compatibility test."""

import json
import select
import socket
import sys


def emit(kind, **fields):
    print(json.dumps({"kind": kind, **fields}), flush=True)


def decode(data):
    end = data.find(b"\r\n")
    if end < 0:
        return None
    if data[:1] != b"*":
        raise ValueError("resp_array_required")
    count = int(data[1:end])
    if not 1 <= count <= 20:
        raise ValueError("resp_command_bound")
    offset = end + 2
    command = []
    for _ in range(count):
        end = data.find(b"\r\n", offset)
        if end < 0:
            return None
        if data[offset : offset + 1] != b"$":
            raise ValueError("resp_bulk_required")
        length = int(data[offset + 1 : end])
        if not 0 <= length <= 8192:
            raise ValueError("resp_argument_bound")
        offset = end + 2
        if len(data) < offset + length + 2:
            return None
        command.append(data[offset : offset + length].decode("utf-8"))
        if data[offset + length : offset + length + 2] != b"\r\n":
            raise ValueError("resp_bulk_terminator")
        offset += length + 2
    return command, offset


server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.bind(("127.0.0.1", 0))
server.listen(5)
clients = {}
evaluations = 0
emit("ready", port=server.getsockname()[1])
try:
    while True:
        ready, _, _ = select.select([server, sys.stdin, *clients], [], [])
        if sys.stdin in ready:
            break
        if server in ready:
            client, address = server.accept()
            if address[0] != "127.0.0.1":
                client.close()
                raise RuntimeError("non_loopback_client")
            clients[client] = b""
        for client in [item for item in ready if item in clients]:
            try:
                chunk = client.recv(16384)
                if not chunk:
                    client.close()
                    del clients[client]
                    continue
                data = clients[client] + chunk
                if len(data) > 16384:
                    raise ValueError("resp_buffer_bound")
                while True:
                    parsed = decode(data)
                    if parsed is None:
                        break
                    command, consumed = parsed
                    data = data[consumed:]
                    emit("command", command=command)
                    name = command[0].upper()
                    if name in ("CLIENT", "SELECT"):
                        client.sendall(b"+OK\r\n")
                    elif name == "INFO":
                        info = b"redis_version:7.2.0\r\nloading:0\r\n"
                        client.sendall(b"$%d\r\n" % len(info) + info + b"\r\n")
                    elif name == "PING":
                        client.sendall(b"+PONG\r\n")
                    elif name == "EVAL":
                        evaluations += 1
                        client.sendall(b"*2\r\n:%d\r\n:59000\r\n" % evaluations)
                    elif name == "QUIT":
                        client.sendall(b"+OK\r\n")
                        client.close()
                        del clients[client]
                        break
                    else:
                        raise ValueError("unexpected_resp_command")
                if client in clients:
                    clients[client] = data
            except (ValueError, UnicodeError, OSError):
                emit("failure", message="invalid_resp_exchange")
                client.close()
                clients.pop(client, None)
finally:
    for client in clients:
        client.close()
    clients.clear()
    server.close()
    emit("closed", remaining=len(clients))
