"""Local integration example. Production authentication/limits belong to the existing backend."""
import argparse,json
from http.server import HTTPServer,BaseHTTPRequestHandler
from run_inference import PredictionService

def make_server(host='127.0.0.1',port=8000):
    service=PredictionService()
    class Handler(BaseHTTPRequestHandler):
        def reply(self,status,data):
            body=json.dumps(data,allow_nan=False).encode();self.send_response(status)
            self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def do_GET(self):
            if self.path=='/health':self.reply(200,dict(status='ok',model_id=service.predictor.metadata['model_id']))
            else:self.reply(404,dict(error='Not found'))
        def do_POST(self):
            if self.path!='/predict':return self.reply(404,dict(error='Not found'))
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=10000000:raise ValueError('Body must be 1..10000000 bytes')
                payload=json.loads(self.rfile.read(size));result=service.predict(payload)
            except (ValueError,KeyError,TypeError,OverflowError) as error:
                return self.reply(400,dict(error=str(error)))
            self.reply(200,result)
    return HTTPServer((host,port),Handler)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8000);args=parser.parse_args()
    server=make_server(port=args.port);print(f'Listening on http://127.0.0.1:{server.server_port}',flush=True);server.serve_forever()
