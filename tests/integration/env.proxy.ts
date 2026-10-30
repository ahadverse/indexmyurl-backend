// Same as ./env but behind one reverse proxy, like production (TRUST_PROXY=1).
process.env.TRUST_PROXY = '1';
import './env';
