"""Local-only peer for Node/Python interoperability; no phone or Facebook access."""
import asyncio
import argparse
import json
import sys
import tempfile
import uuid
import logging
import os
from pathlib import Path
from urllib.parse import urlsplit


async def main(args):
    logging.basicConfig(level=logging.INFO)
    uri = urlsplit(args.uri)
    if uri.hostname != '127.0.0.1' or uri.scheme != 'ws':
        raise ValueError('fixture requires localhost ws only')
    root = Path(args.package)
    sys.path[:0] = [str(root), str(root / '.runtime-deps')]
    from websockets.asyncio.client import connect
    from carrier_v2.transport import run_session, SUBPROTOCOL
    from carrier_v2.fencing import ExecutorFence
    from carrier_v2.executor import Limits

    async def echo(reader, writer):
        upstream = None
        try:
            if args.target_port:
                header = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 5)
                if args.require_auth and b'proxy-authorization: basic zgvkawnhdgvkom9ubhktzml4dhvyzq==' not in header.lower():
                    writer.write(b'HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
                    await writer.drain()
                    return
                expected = ('CONNECT 127.0.0.1:%s HTTP/1.1' % args.target_port).encode()
                if header.split(b'\r\n', 1)[0] != expected:
                    print('fixture_refused_destination', file=sys.stderr, flush=True)
                    writer.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
                    await writer.drain()
                    return
                remote, upstream = await asyncio.open_connection('127.0.0.1', args.target_port)
                writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                await writer.drain()
                async def copy(source, destination):
                    while data := await source.read(32768):
                        destination.write(data)
                        await destination.drain()
                tasks = [asyncio.create_task(copy(reader, upstream)), asyncio.create_task(copy(remote, writer))]
                try:
                    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                return
            while data := await reader.read(32768):
                writer.write(data)
                await writer.drain()
        finally:
            if upstream:
                upstream.close()
                await upstream.wait_closed()
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(echo, '127.0.0.1', args.listen_port)
    port = server.sockets[0].getsockname()[1]
    print(json.dumps({'fixture': True, 'port': port}), flush=True)
    state = None if args.state_directory else tempfile.TemporaryDirectory(prefix='cp2-r2-peer-')
    fence = ExecutorFence(args.state_directory or state.name, args.instance_id, args.resource_id, 'test-receipt', bytes([4])*32,
                          {'test': bytes([3])*32}, authority_epoch=args.authority_epoch)
    fence.acquire()
    try:
        async with connect(args.uri, subprotocols=[SUBPROTOCOL],
                           additional_headers={'Authorization': 'Bearer test-only-channel'},
                           max_size=65536, max_queue=8, compression=None) as ws:
            limits=Limits(flows=384,per_operation=64,fleet=6,per_phone=3) if os.environ.get('CP2_LAB_CURRENT_CAPACITY')=='1' else None
            await run_session(ws, {'test': bytes([3]) * 32}, {'p001': port}, fence=fence,limits=limits,takeover_seconds=60)
    finally:
        await fence.shutdown()
        if state:
            state.cleanup()
        server.close()
        await server.wait_closed()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--package', required=True)
    parser.add_argument('--uri', required=True)
    parser.add_argument('--target-port', type=int, default=0)
    parser.add_argument('--require-auth', action='store_true')
    parser.add_argument('--instance-id', default=str(uuid.uuid4()))
    parser.add_argument('--resource-id', default=str(uuid.uuid4()))
    parser.add_argument('--authority-epoch', default=str(uuid.uuid4()))
    parser.add_argument('--state-directory')
    parser.add_argument('--listen-port', type=int, default=0)
    asyncio.run(main(parser.parse_args()))
