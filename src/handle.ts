import { ErrorResponse, HTTPHandle, Route } from 'codebase'
import pkg from '../package.json'
import axios from 'axios'
import { AuthorizationVerifyResponse } from 'y-types/service'
import { Types, isValidObjectId } from 'mongoose'
import type { FeedModel, FollowInjuctionModel, PostInterface, PostModel, UserModel } from './schema'
import multer from 'multer'
import { Storage } from '@google-cloud/storage'
import { v4 } from 'uuid'
import { format } from 'node:util'

export function setUpHandle(handle: HTTPHandle) {
  handle.initiateHealthCheckRoute(pkg.version);

  const Post: PostModel = handle.app.locals.schema.Post;
  const User: UserModel = handle.app.locals.schema.User;
  const FollowInjuction: FollowInjuctionModel = handle.app.locals.schema.FollowInjuction;
  const Feed: FeedModel = handle.app.locals.schema.Feed;

  handle.createRoute('/',(route: Route) => {
    route.setGlobalMiddleware('Verify jwt token', async (req, res, next) => {
      try {
        if (!req.headers.authorization) {
          return handle.createResponse(req, res, null, new ErrorResponse('Missing authorization', 401));
        }
  
        const [type, token] = req.headers.authorization.split(' ');

        if (type !== 'Bearer') {
          return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized token type', 401));
        }
  
        if (!token) {
          return handle.createResponse(req, res, null, new ErrorResponse('Missing token', 401));
        }
  
        const response = await axios.post<AuthorizationVerifyResponse>('https://authorization-service-2fqcvdzp6q-ew.a.run.app', {
          type: 'verify',
          token
        })
          .catch((e) => e.response);

        if (response.status !== 200) {
          throw new Error('Unable to create user');
        }

        if (response.data.error) {
          return new Error(response.data.error.message);
        }

        if (!response.data.result) {
          return handle.createResponse(req, res, null, new ErrorResponse('Authorization service unable verify token', 500));
        }

        const {valide, decoded} = response.data.result;

        if (!valide) {
          return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized token', 401));
        }

        res.locals.authorization = decoded;

        next();
      } catch (error) {
        console.error(error);

        return handle.createResponse(req, res, null, new ErrorResponse('Unable to verify token', 500));
      }
    })

    route.setGlobalMiddleware('Verify audience authorization', (req, res, next) => {
      const { aud } = res.locals.authorization;

      const [platform, location, target] = aud.split(':');

      if (platform != 'y') {
        return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized audience platform', 401));
      }

      if (location !== 'services' && location !== '*') {
        return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized audience location', 401));
      }

      if (target !== 'users' && target !== '*') {
        return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized audience target', 401));
      }

      next();
    })

    route.setGlobalMiddleware('Verify subject authorization', async (req, res, next) => {
      const { sub } = res.locals.authorization;

      const [platform, location, id] = sub.split(':');

      if (platform != 'y') {
        return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized subject platform', 401));
      }

      if (location !== 'users' && location !== '*') {
        return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized subject location', 401));
      }

      if (!id) {
        return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized subject id', 401));
      }

      if (!isValidObjectId(id)) {
        return handle.createResponse(req, res, null, new ErrorResponse('Invalid subject id', 401));
      }

      res.locals.userId = Types.ObjectId.createFromHexString(id);

      next();
    })

    const storage = new Storage();

    const uploadHandler = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 5 * 1024 * 1024
      }
    });

    if (!process.env.GCLOUD_STORAGE_BUCKET) {
      throw new Error('Missing google cloud storage bucket');
    }

    const bucket = storage.bucket(process.env.GCLOUD_STORAGE_BUCKET);

    route.mapper.post(
      '/',
      uploadHandler.array('images', 4),
      async (req, res) => {
        try {
          if (!req.body.content) {
            return handle.createResponse(req, res, null, new ErrorResponse('Missing body content', 401));
          }

          if (!req.body.content && !req.body.ref) {
            return handle.createResponse(req, res, null, new ErrorResponse('Content and Ref missing'));
          }

          if (req.body.content && req.body.content.length > 255) {
            return handle.createResponse(req, res, null, new ErrorResponse('Content is longer than 255 character'));
          }

          const postData: PostInterface & { _id: Types.ObjectId } = {
            _id: new Types.ObjectId(),
            user: res.locals.userId,
            content: null,
            ref: null,
            timestamp: new Date(),
            likes: [],
            images: []
          };

          if (req.body.ref) {
            if (!isValidObjectId(req.body.ref)) {
              return handle.createResponse(req, res, null, new ErrorResponse('Invalid ref Id', 400));
            }
            postData.ref = Types.ObjectId.createFromHexString(req.body.ref);

            const exist = await Post
              .findById(postData.ref)
              .countDocuments()
              .exec();

            if (exist < 1) {
              return handle.createResponse(req, res, null, new ErrorResponse('Reference post not exist', 404));
            }
          }

          if (req.body.content) {
            postData.content = req.body.content;
          }

          if (req.files && req.files.length as number > 0) {
            const files = req.files as Array<{
              fieldname: string;
              originalname: string;
              encoding: string;
              mimetype: string;
              buffer: Buffer;
              size: number;
            }>

            console.log('Uploading %s images ...', files.length);
            for (const file of files) {
              const discriminator = v4();

              let ext = file.originalname.split('.').pop();

              if (!ext) {
                switch (file.mimetype) {
                  case 'image/jpeg':
                    ext = 'jpeg';
                    break;
                  case 'image/png':
                    ext = 'png';
                    break;
                  case 'image/gif':
                    ext = 'gif';
                    break;
                  case 'image/webp':
                    ext = 'webp';
                    break;
                  default:
                    return handle.createResponse(req, res, null, new ErrorResponse('Unsupported file type', 400));
                }
              }

              const fileName = `${discriminator}.${ext}`;

              const blob = bucket.file(`posts/${res.locals.userId}/${fileName}`);
              const blobStream = blob.createWriteStream();

              await new Promise((resolve, reject) => {
                console.log('Uploading image ...');
                blobStream.on('error', (error) => {
                  reject(error);
                });

                blobStream.on('finish', async () => {
                  postData.images.push(fileName);
                  console.log('Upload image success');
                  resolve(void 0);
                });

                blobStream.end(file.buffer);
              })
            }
          }

          console.log('All image uploaded');

          const post = new Post(postData);

          await post.save();

          return handle.createResponse(req, res, post, null);
        } catch (error) {
          console.error(error);
          return handle.createResponse(req, res, null, new ErrorResponse('Unable to create post', 500));
        }
      })

    route.mapper.post(
      '/:id/repost',
      uploadHandler.array('images', 4),
      async (req, res) => {
      try {
        if (!req.params.id) {
          return handle.createResponse(req, res, null, new ErrorResponse('Missing params id', 401));
        }
  
        if (!isValidObjectId(req.params.id)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Invalid params id', 401));
        }

        const id = Types.ObjectId.createFromHexString(req.params.id);

        const postDoc = await Post
          .findById(id)
          .select({
            _id: 1,
            user: 1,
            content: 1,
            images:1,
            timestamp: 1,
            likes: 1, reposts: 1
          })
          .exec();

        if (!postDoc) {
          return handle.createResponse(req, res, null, new ErrorResponse('Post not found', 404));
        }

        const repostData: PostInterface & { _id: Types.ObjectId } = {
          _id: new Types.ObjectId(),
          user: res.locals.userId,
          content: null,
          images: [],
          ref: Types.ObjectId.createFromHexString(req.params.id),
          timestamp: new Date(),
          likes: [],
        }

        if (req.body.content) {
          if (req.body.content.length > 255) {
            return handle.createResponse(req, res, null, new ErrorResponse('Content is longer than 255 character', 400));
          }

          repostData.content = req.body.content;
        }

        if (req.files && req.files.length as number > 0) {
          const files = req.files as Array<{
            fieldname: string;
            originalname: string;
            encoding: string;
            mimetype: string;
            buffer: Buffer;
            size: number;
          }>

          console.log('Uploading %s images ...', files.length);
          for (const file of files) {
            const discriminator = v4();

            let ext = file.originalname.split('.').pop();

            if (!ext) {
              switch (file.mimetype) {
                case 'image/jpeg':
                  ext = 'jpeg';
                  break;
                case 'image/png':
                  ext = 'png';
                  break;
                case 'image/gif':
                  ext = 'gif';
                  break;
                case 'image/webp':
                  ext = 'webp';
                  break;
                default:
                  return handle.createResponse(req, res, null, new ErrorResponse('Unsupported file type', 400));
              }
            }

            const fileName = `${discriminator}.${ext}`;

            const blob = bucket.file(`posts/${res.locals.userId}/${fileName}`);
            const blobStream = blob.createWriteStream();

            await new Promise((resolve, reject) => {
              console.log('Uploading image ...');
              blobStream.on('error', (error) => {
                reject(error);
              });

              blobStream.on('finish', async () => {
                repostData.images.push(fileName);
                console.log('Upload image success');
                resolve(void 0);
              });

              blobStream.end(file.buffer);
            })
          }
        }

        console.log('All image uploaded');

        const repostDoc = new Post(repostData);

        await repostDoc.populate('user', { _id: 1, username: 1, picture: 1 });

        await repostDoc.populate({
          path: 'ref',
          select: {
            _id: 1,
            user: 1,
            content: 1,
            images: 1,
            timestamp: 1,
            likes: 1,
            reposts: 1
          },
          populate: {
            path: 'user',
            select: {
              _id: 1,
              username: 1,
              picture: 1
            }
          }
        });

        await repostDoc.save();

        return handle.createResponse(req, res, repostDoc, null);
      } catch (error) {
        console.error(error);
        return handle.createResponse(req, res, null, new ErrorResponse('Unable to repost post', 500));
      }
    })

    route.mapper.put('/:id/like', async (req, res) => {
      try {
        if (!req.params.id) {
          return handle.createResponse(req, res, null, new ErrorResponse('Missing params id', 401));
        }
  
        if (!isValidObjectId(req.params.id)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Invalid params id', 401));
        }

        const id = Types.ObjectId.createFromHexString(req.params.id);

        const postDoc = await Post
          .findById(id)
          .select({ _id: 1, user: 1 ,content: 1, images: 1, timestamp: 1, likes: 1, reposts: 1})
          .populate('user', { _id: 1, username: 1 })
          .exec();

        if (!postDoc) {
          return handle.createResponse(req, res, null, new ErrorResponse('Post not found', 404));
        }

        if (postDoc.likes.includes(res.locals.userId)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Already liked post', 400));
        }

        postDoc.likes.push(res.locals.userId);

        await postDoc.save();

        return res.status(204).end();
      } catch (error) {
        console.error(error);
        return handle.createResponse(req, res, null, new ErrorResponse('Unable to like post', 500));
      }
    })

    route.mapper.delete('/:id/like', async (req, res) => {
      try {
        if (!req.params.id) {
          return handle.createResponse(req, res, null, new ErrorResponse('Missing params id', 401));
        }
  
        if (!isValidObjectId(req.params.id)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Invalid params id', 401));
        }

        const id = Types.ObjectId.createFromHexString(req.params.id);

        const postDoc = await Post
          .findById(id)
          .select({ _id: 1, user: 1 ,content: 1, images: 1, timestamp: 1, likes: 1, reposts: 1})
          .populate('user', { _id: 1, username: 1 })
          .exec();

        if (!postDoc) {
          return handle.createResponse(req, res, null, new ErrorResponse('Post not found', 404));
        }

        if (!postDoc.likes.includes(res.locals.userId)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Not liked post', 400));
        }

        postDoc.likes = postDoc.likes.filter((userId) => !(userId == res.locals.userId));

        await postDoc.save();

        return handle.createResponse(req, res, null, null);
      } catch (error) {
        console.error(error);
        return handle.createResponse(req, res, null, new ErrorResponse('Unable to unlike post', 500));
      }
    })

    route.mapper.route('/feed')
      .get(async (req, res) => {
        try {
          if (!req.query.id) {
            return handle.createResponse(req, res, null, new ErrorResponse('Missing query id', 401));
          }
          if (!req.query.page) {
            return handle.createResponse(req, res, null, new ErrorResponse('Missing query page', 401));
          }
          if (!req.query.limit) {
            return handle.createResponse(req, res, null, new ErrorResponse('Missing query limit', 401));
          }

          if (!['fyp', 'subscriptions'].includes(req.query.id as string) && !isValidObjectId(req.query.id as string)) {
            return handle.createResponse(req, res, null, new ErrorResponse('Invalid query id', 401));
          }

          const skip = (parseInt(req.query.page as string) - 1) * parseInt(req.query.limit as string);

          if (req.query.id === 'fyp') {
            const posts = await Post
              .find()
              .sort({ timestamp: -1 })
              .select({
                _id: 1,
                user: 1,
                content: 1,
                images: 1,
                timestamp: 1,
                likes: 1,
                reposts: 1,
                ref: 1
              })
              .populate('user', {
                _id: 1,
                username: 1,
                picture: 1
              })
              .populate({
                path: 'ref',
                select: {
                  _id: 1,
                  user: 1,
                  content: 1,
                  images: 1,
                  timestamp: 1,
                  likes: 1,
                  reposts: 1
                },
                populate: {
                  path: 'user',
                  select: {
                    _id: 1,
                    username: 1,
                    picture: 1
                  }
                }
              })
              .limit(parseInt(req.query.limit as string))
              .skip(skip)
              .exec();

            return handle.createResponse(req, res, posts, null);
          }

          if (req.query.id === 'subscriptions') {
            const userDoc = await User
              .findById(res.locals.userId)
              .exec();

            if (!userDoc) {
              return handle.createResponse(req, res, null, new ErrorResponse('User not found', 404));
            }

            const following = await FollowInjuction
              .find({ source: userDoc._id })
              .select({ target: 1 })
              .exec();

            const posts = await Post
              .find({ user: { $in: following.map(({ target }) => target) } })
              .sort({ timestamp: -1 })
              .select({
                _id: 1,
                user: 1,
                content: 1,
                images: 1,
                timestamp: 1,
                likes: 1,
                reposts: 1,
                ref: 1
              })
              .populate('user', {
                _id: 1,
                username: 1,
                picture: 1
              })
              .populate({
                path: 'ref',
                select: {
                  _id: 1,
                  user: 1,
                  content: 1,
                  images: 1,
                  timestamp: 1,
                  likes: 1,
                  reposts: 1
                },
                populate: {
                  path: 'user',
                  select: {
                    _id: 1,
                    username: 1,
                    picture: 1
                  }
                }
              })
              .limit(parseInt(req.query.limit as string))
              .skip(skip)
              .exec();

            return handle.createResponse(req, res, posts, null);
          }
          
          const id = Types.ObjectId.createFromHexString(req.query.id as string);

          const feed = await Feed
            .findOne({ _id: id, userId: res.locals.userId })
            .select({ fromIds: 1 })
            .exec();

          if (!feed) {
            return handle.createResponse(req, res, null, new ErrorResponse('Feed not found', 404));
          }

          const posts = await Post
            .find({ user: { $in: feed.fromIds } })
            .sort({ timestamp: -1 })
            .select({
              _id: 1,
              user: 1,
              content: 1,
              images: 1,
              timestamp: 1,
              likes: 1,
              ref: 1
            })
            .populate('user', {
              _id: 1,
              username: 1,
              picture: 1
            })
            .populate({
              path: 'ref',
              select: {
                _id: 1,
                user: 1,
                content: 1,
                images: 1,
                timestamp: 1,
                likes: 1,
                reposts: 1
              },
              populate: {
                path: 'user',
                select: {
                  _id: 1,
                  username: 1,
                  picture: 1
                }
              }
            })
            .limit(parseInt(req.query.limit as string))
            .skip(skip)
            .exec();

          return handle.createResponse(req, res, posts, null);
        } catch (error) {
          console.error(error);
          return handle.createResponse(req, res, null, new ErrorResponse('Unable to get feed', 500));
        }
      })
      .post(async (req, res) => {
        try {
          if (!req.body.userIds) {
            return handle.createResponse(req, res, null, new ErrorResponse('Missing body usersId', 401));
          }
          const userIds = req.body.userIds as string[];

          for (const userId of userIds) {
            if (!isValidObjectId(userId)) {
              return handle.createResponse(req, res, null, new ErrorResponse(format('Invalid user id (%s)', userId), 401));
            }
          }

          const userObjectIds = userIds.map((userId) => Types.ObjectId.createFromHexString(userId));

          const usersCount = await User
            .find({ _id: { $in: userObjectIds } })
            .countDocuments()
            .exec();

          if (usersCount !== userObjectIds.length) {
            return handle.createResponse(req, res, null, new ErrorResponse('Some user not found', 401));
          }

          const feed = new Feed({
            userId: res.locals.userId,
            fromIds: userObjectIds
          });

          await feed.save();

          return handle.createResponse(req, res, feed, null);
        } catch (error) {
          console.error(error);
          return handle.createResponse(req, res, null, new ErrorResponse('Unable to create feed', 500));
        }
      })

    route.mapper.route('/:id')
      .get(async (req, res) => {
        try {
          if (!req.params.id) {
            return handle.createResponse(req, res, null, new ErrorResponse('Missing params id', 401));
          }

          if (!isValidObjectId(req.params.id)) {
            return handle.createResponse(req, res, null, new ErrorResponse('Invalid subject id', 401))
          }

          const id = Types.ObjectId.createFromHexString(req.params.id);

          const postDoc = await Post
            .findById(id)
            .select({
              _id: 1,
              user: 1,
              content: 1,
              images: 1,
              timestamp: 1,
              likes: 1,
              ref: 1,
            })
            .populate('user', {
              _id: 1,
              username: 1,
              picture: 1
            })
            .exec();

            if (!postDoc) {
              return handle.createResponse(req, res, null, new ErrorResponse('Post not found', 404));
            }

            return handle.createResponse(req, res, postDoc, null);
        } catch (err) {
          console.error(err);

          return handle.createResponse(req, res, null, new ErrorResponse('Unable to get post', 500));
        }
      })
      .delete(async (req, res) => {
        try {
          if (!req.params.id) {
            return handle.createResponse(req, res, null, new ErrorResponse('Missing params id', 401));
          } 

          if (!isValidObjectId(req.params.id)) {
            return handle.createResponse(req, res, null, new ErrorResponse('Invalid params id', 401));
          }

          const id = Types.ObjectId.createFromHexString(req.params.id);

          const postDoc = await Post
            .findById(id)
            .exec();

          if (!postDoc) {
            return handle.createResponse(req, res, null, new ErrorResponse('Post not found', 404));
          }

          if (!postDoc.user.equals(res.locals.userId)) {
            return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized user', 401));
          }

          await postDoc.deleteOne();

          return res.status(204).end();
        } catch (error) {
          console.error(error);
          return handle.createResponse(req, res, null, new ErrorResponse('Unable to delete post', 500));
        }
      })
  })

  handle.initiateNotFoundRoute();
}