import 'dotenv/config'
import Core from 'codebase'
import { setUpHandle } from './handle';
import { FollowInjuctionSchema, PostSchema, UserSchema, FeedSchema } from './schemas';
import type {
  PostSchema as IPostSchema,
  UserSchema as IUserSchema,
  FollowInjuctionSchema as IFollowInjuctionSchema,
  FeedSchema as IFeedSchema
} from './schema';


const CERTIFICATE_KEY = 'DB_CERTIFICATE';
const CERTIFICATE_DATABASE_NAME = process.env.CERTIFICATE_DATABASE_NAME;

const core = Core.instanciateFromEnv();

async function bootstrap() {
  if (!CERTIFICATE_DATABASE_NAME) {
    throw new Error('Missing certificate database name in env');
  }

  await core.KMService.fetchSecret(
    CERTIFICATE_DATABASE_NAME,
    CERTIFICATE_KEY
  );
  
  core.DBService.getSecretFromKMS(CERTIFICATE_KEY);

  const client = await core.DBService.createClient();

  const Post = client.model<IPostSchema>('Posts', PostSchema);
  const User = client.model<IUserSchema>('Users', UserSchema);
  const FollowInjuction = client.model<IFollowInjuctionSchema>('FollowInjuctions', FollowInjuctionSchema);
  const Feed = client.model<IFeedSchema>('Feeds', FeedSchema);

  const handle = core.HTTPService.handle;
  handle.app.locals.schema = {
    Post,
    User,
    FollowInjuction,
    Feed,
  }

  setUpHandle(handle);

  const server = core.HTTPService.createServer();

  server.on('connection', (socket) => {
    console.log('New connection from %s', socket.remoteAddress);
  })
}

bootstrap();